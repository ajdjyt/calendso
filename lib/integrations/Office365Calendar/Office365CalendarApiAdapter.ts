import { Calendar as OfficeCalendar } from "@microsoft/microsoft-graph-types-beta";
import { Credential } from "@prisma/client";

import { CalendarApiAdapter, CalendarEvent, IntegrationCalendar } from "@lib/calendarClient";
import { handleErrorsJson, handleErrorsRaw } from "@lib/errors";
import prisma from "@lib/prisma";

export type BufferedBusyTime = {
  start: string;
  end: string;
};

type O365AuthCredentials = {
  expiry_date: number;
  access_token: string;
  refresh_token: string;
};

const o365Auth = (credential: Credential) => {
  const isExpired = (expiryDate: number) => expiryDate < Math.round(+new Date() / 1000);
  const o365AuthCredentials = credential.key as O365AuthCredentials;

  const refreshAccessToken = (refreshToken: string) => {
    return fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        scope: "User.Read Calendars.Read Calendars.ReadWrite",
        client_id: process.env.MS_GRAPH_CLIENT_ID!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        client_secret: process.env.MS_GRAPH_CLIENT_SECRET!,
      }),
    })
      .then(handleErrorsJson)
      .then((responseBody) => {
        o365AuthCredentials.access_token = responseBody.access_token;
        o365AuthCredentials.expiry_date = Math.round(+new Date() / 1000 + responseBody.expires_in);
        return prisma.credential
          .update({
            where: {
              id: credential.id,
            },
            data: {
              key: o365AuthCredentials,
            },
          })
          .then(() => o365AuthCredentials.access_token);
      });
  };

  return {
    getToken: () =>
      !isExpired(o365AuthCredentials.expiry_date)
        ? Promise.resolve(o365AuthCredentials.access_token)
        : refreshAccessToken(o365AuthCredentials.refresh_token),
  };
};

export const Office365CalendarApiAdapter = (credential: Credential): CalendarApiAdapter => {
  const auth = o365Auth(credential);

  const translateEvent = (event: CalendarEvent) => {
    return {
      subject: event.title,
      body: {
        contentType: "HTML",
        content: event.description,
      },
      start: {
        dateTime: event.startTime,
        timeZone: event.organizer.timeZone,
      },
      end: {
        dateTime: event.endTime,
        timeZone: event.organizer.timeZone,
      },
      attendees: event.attendees.map((attendee) => ({
        emailAddress: {
          address: attendee.email,
          name: attendee.name,
        },
        type: "required",
      })),
      location: event.location ? { displayName: event.location } : undefined,
    };
  };

  const integrationType = "office365_calendar";

  function listCalendars(): Promise<IntegrationCalendar[]> {
    return auth.getToken().then((accessToken) =>
      fetch("https://graph.microsoft.com/v1.0/me/calendars", {
        method: "get",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
      })
        .then(handleErrorsJson)
        .then((responseBody: { value: OfficeCalendar[] }) => {
          return responseBody.value.map((cal) => {
            const calendar: IntegrationCalendar = {
              externalId: cal.id ?? "No Id",
              integration: integrationType,
              name: cal.name ?? "No calendar name",
              primary: cal.isDefaultCalendar ?? false,
            };
            return calendar;
          });
        })
    );
  }

  return {
    getAvailability: (dateFrom, dateTo, selectedCalendars) => {
      const filter = `?startdatetime=${encodeURIComponent(dateFrom)}&enddatetime=${encodeURIComponent(
        dateTo
      )}`;
      return auth
        .getToken()
        .then((accessToken) => {
          const selectedCalendarIds = selectedCalendars
            .filter((e) => e.integration === integrationType)
            .map((e) => e.externalId)
            .filter(Boolean);
          if (selectedCalendarIds.length === 0 && selectedCalendars.length > 0) {
            // Only calendars of other integrations selected
            return Promise.resolve([]);
          }

          return (
            selectedCalendarIds.length === 0
              ? listCalendars().then((cals) => cals.map((e) => e.externalId).filter(Boolean) || [])
              : Promise.resolve(selectedCalendarIds)
          ).then((ids) => {
            const requests = ids.map((calendarId, id) => ({
              id,
              method: "GET",
              headers: {
                Prefer: 'outlook.timezone="Etc/GMT"',
              },
              url: `/me/calendars/${calendarId}/calendarView${filter}`,
            }));

            type BatchResponse = {
              responses: SubResponse[];
            };
            type SubResponse = {
              body: { value: { start: { dateTime: string }; end: { dateTime: string } }[] };
            };

            return fetch("https://graph.microsoft.com/v1.0/$batch", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ requests }),
            })
              .then(handleErrorsJson)
              .then((responseBody: BatchResponse) =>
                responseBody.responses.reduce(
                  (acc: BufferedBusyTime[], subResponse) =>
                    acc.concat(
                      subResponse.body.value.map((evt) => {
                        return {
                          start: evt.start.dateTime + "Z",
                          end: evt.end.dateTime + "Z",
                        };
                      })
                    ),
                  []
                )
              );
          });
        })
        .catch((err) => {
          console.log(err);
          return Promise.reject([]);
        });
    },
    createEvent: (event: CalendarEvent) =>
      auth.getToken().then((accessToken) =>
        fetch("https://graph.microsoft.com/v1.0/me/calendar/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(translateEvent(event)),
        }).then(handleErrorsJson)
      ),
    deleteEvent: (uid: string) =>
      auth.getToken().then((accessToken) =>
        fetch("https://graph.microsoft.com/v1.0/me/calendar/events/" + uid, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + accessToken,
          },
        }).then(handleErrorsRaw)
      ),
    updateEvent: (uid: string, event: CalendarEvent) =>
      auth.getToken().then((accessToken) =>
        fetch("https://graph.microsoft.com/v1.0/me/calendar/events/" + uid, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(translateEvent(event)),
        }).then(handleErrorsRaw)
      ),
    listCalendars,
  };
};
