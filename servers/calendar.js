/**
 * calendar.js — Google Calendar operations for any configured account
 */

import { getCalendar, getEmail, resolveAccounts } from "./auth.js";
import { getAccounts } from "./config.js";

const DEFAULT_TZ = "America/Chicago";

export async function listEvents({
  account,
  timeMin,
  timeMax,
  maxResults = 25,
  query,
}) {
  const labels = resolveAccounts(account);
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const tMin = timeMin || now.toISOString();
  const tMax = timeMax || weekLater.toISOString();

  const allEvents = [];

  await Promise.all(
    labels.map(async (label) => {
      try {
        const cal = getCalendar(label);
        const params = {
          calendarId: "primary",
          timeMin: tMin,
          timeMax: tMax,
          maxResults,
          singleEvents: true,
          orderBy: "startTime",
          timeZone: DEFAULT_TZ,
        };
        if (query) params.q = query;

        const res = await cal.events.list(params);
        const events = (res.data.items || []).map((e) => ({
          account: label,
          accountEmail: getEmail(label),
          id: e.id,
          summary: e.summary || "(no title)",
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          allDay: !!e.start?.date,
          location: e.location || "",
          description: e.description
            ? e.description.substring(0, 500)
            : "",
          attendees: (e.attendees || []).map((a) => ({
            email: a.email,
            status: a.responseStatus,
          })),
          meetLink: e.hangoutLink || "",
          status: e.status,
        }));
        allEvents.push(...events);
      } catch (err) {
        allEvents.push({ account: label, error: err.message });
      }
    })
  );

  allEvents.sort((a, b) => {
    const da = a.start ? new Date(a.start) : new Date(0);
    const db = b.start ? new Date(b.start) : new Date(0);
    return da - db;
  });

  return allEvents;
}

export async function createEvent({
  account,
  summary,
  startTime,
  endTime,
  description,
  location,
  allDay,
  attendees,
  conferenceType,
}) {
  const cal = getCalendar(account);

  const event = { summary };
  if (allDay) {
    event.start = { date: startTime };
    event.end = { date: endTime };
  } else {
    event.start = { dateTime: startTime, timeZone: DEFAULT_TZ };
    event.end = { dateTime: endTime, timeZone: DEFAULT_TZ };
  }
  if (description) event.description = description;
  if (location) event.location = location;
  if (attendees?.length) {
    event.attendees = attendees.map((email) => ({ email }));
  }

  const params = { calendarId: "primary", requestBody: event };
  if (conferenceType === "meet") {
    params.conferenceDataVersion = 1;
    event.conferenceData = {
      createRequest: {
        requestId: `mcp-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const res = await cal.events.insert(params);
  return {
    account,
    eventId: res.data.id,
    summary: res.data.summary,
    start: res.data.start?.dateTime || res.data.start?.date,
    end: res.data.end?.dateTime || res.data.end?.date,
    meetLink: res.data.hangoutLink || "",
    htmlLink: res.data.htmlLink,
    status: "created",
  };
}

export async function updateEvent({
  account,
  eventId,
  summary,
  description,
  location,
  startTime,
  endTime,
  attendees,
}) {
  const cal = getCalendar(account);
  const existing = await cal.events.get({
    calendarId: "primary",
    eventId,
  });

  const patch = {};
  if (summary !== undefined) patch.summary = summary;
  if (description !== undefined) patch.description = description;
  if (location !== undefined) patch.location = location;
  if (startTime) {
    patch.start = startTime.includes("T")
      ? { dateTime: startTime, timeZone: DEFAULT_TZ }
      : { date: startTime };
  }
  if (endTime) {
    patch.end = endTime.includes("T")
      ? { dateTime: endTime, timeZone: DEFAULT_TZ }
      : { date: endTime };
  }
  if (attendees) patch.attendees = attendees.map((email) => ({ email }));

  const res = await cal.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: patch,
  });

  return {
    account,
    eventId: res.data.id,
    summary: res.data.summary,
    start: res.data.start?.dateTime || res.data.start?.date,
    status: "updated",
  };
}

export async function deleteEvent({ account, eventId }) {
  const cal = getCalendar(account);
  await cal.events.delete({ calendarId: "primary", eventId });
  return { account, eventId, status: "deleted" };
}

export async function findFreeTime({
  timeMin,
  timeMax,
  duration = 30,
  workingHoursOnly = true,
  workingHoursStart = 8,
  workingHoursEnd = 18,
}) {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    return { error: "No accounts configured. Run setup first." };
  }

  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const tMin = timeMin ? new Date(timeMin) : now;
  const tMax = timeMax ? new Date(timeMax) : weekLater;

  // Fetch all events from all accounts
  const allBusy = [];
  await Promise.all(
    accounts.map(async (acct) => {
      try {
        const cal = getCalendar(acct.label);
        const res = await cal.events.list({
          calendarId: "primary",
          timeMin: tMin.toISOString(),
          timeMax: tMax.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 200,
          timeZone: DEFAULT_TZ,
        });
        for (const e of res.data.items || []) {
          if (e.start?.date) continue; // skip all-day
          const declined = (e.attendees || []).some(
            (a) => a.self && a.responseStatus === "declined"
          );
          if (declined) continue;

          allBusy.push({
            start: new Date(e.start.dateTime),
            end: new Date(e.end.dateTime),
            summary: e.summary,
            account: acct.label,
          });
        }
      } catch (err) {
        // Skip failed accounts
      }
    })
  );

  // Sort and merge overlapping busy times
  allBusy.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const b of allBusy) {
    if (merged.length && b.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = new Date(
        Math.max(merged[merged.length - 1].end, b.end)
      );
    } else {
      merged.push({ start: new Date(b.start), end: new Date(b.end) });
    }
  }

  // Walk day by day, find free slots
  const durationMs = duration * 60 * 1000;
  const freeSlots = [];
  const current = new Date(tMin);
  current.setHours(0, 0, 0, 0);

  while (current < tMax && freeSlots.length < 30) {
    const dayOfWeek = current.getDay();
    if (workingHoursOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
      current.setDate(current.getDate() + 1);
      continue;
    }

    const dayStart = new Date(current);
    const dayEnd = new Date(current);
    if (workingHoursOnly) {
      dayStart.setHours(workingHoursStart, 0, 0, 0);
      dayEnd.setHours(workingHoursEnd, 0, 0, 0);
    } else {
      dayStart.setHours(0, 0, 0, 0);
      dayEnd.setHours(23, 59, 59, 999);
    }

    const effectiveStart = dayStart < tMin ? tMin : dayStart;
    const effectiveEnd = dayEnd > tMax ? tMax : dayEnd;

    if (effectiveStart < effectiveEnd) {
      let cursor = new Date(effectiveStart);
      const dayBusy = merged.filter(
        (b) => b.start < effectiveEnd && b.end > effectiveStart
      );

      for (const b of dayBusy) {
        if (b.start > cursor) {
          const gap = b.start - cursor;
          if (gap >= durationMs) {
            freeSlots.push({
              start: cursor.toISOString(),
              end: b.start.toISOString(),
              durationMinutes: Math.round(gap / 60000),
            });
          }
        }
        if (b.end > cursor) cursor = new Date(b.end);
      }

      if (cursor < effectiveEnd) {
        const gap = effectiveEnd - cursor;
        if (gap >= durationMs) {
          freeSlots.push({
            start: cursor.toISOString(),
            end: effectiveEnd.toISOString(),
            durationMinutes: Math.round(gap / 60000),
          });
        }
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return {
    accountsChecked: accounts.map((a) => `${a.label} (${a.email})`),
    range: { from: tMin.toISOString(), to: tMax.toISOString() },
    minSlotMinutes: duration,
    workingHoursOnly,
    freeSlots,
  };
}
