import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectBusySlots,
  assertCalendarsReadable,
} from "../calendar.js";

const accounts = [
  { label: "personal", email: "donald@example.com" },
  { label: "work", email: "donald@work.example.com" },
];

const tMin = new Date("2026-11-04T00:00:00Z");
const tMax = new Date("2026-11-11T00:00:00Z");

function listing(items) {
  return { data: { items } };
}

const timed = {
  summary: "standup",
  start: { dateTime: "2026-11-04T16:00:00Z" },
  end: { dateTime: "2026-11-04T16:15:00Z" },
};

test("a failed calendar is reported, not dropped", async () => {
  const listEvents = async () => {
    throw new Error("Google Calendar API has not been used in project 123 before or it is disabled");
  };

  const { allBusy, unreadable } = await collectBusySlots(accounts, tMin, tMax, listEvents);

  assert.deepEqual(allBusy, []);
  assert.equal(unreadable.length, 2);
  assert.equal(unreadable[0].account, "personal");
  assert.match(unreadable[0].error, /has not been used in project 123/);
});

test("one readable account keeps its slots while the other is reported", async () => {
  const listEvents = async (label) => {
    if (label === "work") throw new Error("invalid_grant");
    return listing([timed]);
  };

  const { allBusy, unreadable } = await collectBusySlots(accounts, tMin, tMax, listEvents);

  assert.equal(allBusy.length, 1);
  assert.equal(allBusy[0].account, "personal");
  assert.deepEqual(unreadable.map((u) => u.account), ["work"]);
});

test("all-day and declined events are not busy time", async () => {
  const listEvents = async () =>
    listing([
      { summary: "holiday", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } },
      {
        summary: "skipped",
        start: { dateTime: "2026-11-04T18:00:00Z" },
        end: { dateTime: "2026-11-04T19:00:00Z" },
        attendees: [{ self: true, responseStatus: "declined" }],
      },
    ]);

  const { allBusy, unreadable } = await collectBusySlots(accounts, tMin, tMax, listEvents);

  assert.deepEqual(allBusy, []);
  assert.deepEqual(unreadable, []);
});

test("free slots are refused when no calendar could be read", () => {
  const unreadable = accounts.map((a) => ({
    account: a.label,
    email: a.email,
    error: "calendar API disabled",
  }));

  assert.throws(
    () => assertCalendarsReadable(accounts, unreadable),
    /Could not read any configured calendar: personal .*calendar API disabled/
  );
});

test("a partially readable set is allowed through", () => {
  assert.doesNotThrow(() =>
    assertCalendarsReadable(accounts, [
      { account: "work", email: "donald@work.example.com", error: "invalid_grant" },
    ])
  );
  assert.doesNotThrow(() => assertCalendarsReadable(accounts, []));
});
