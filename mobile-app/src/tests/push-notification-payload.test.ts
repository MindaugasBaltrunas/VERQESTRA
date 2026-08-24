import assert from "node:assert/strict";
import test from "node:test";
import { parsePushNotification } from "../adapters/push-notification-adapter.js";
import { accepted, delivery } from "./push-notification-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `push-notification-adapter.test.ts`). Čia — vienas
 * laukas ir viena taisyklė: `occurredAt` privalo būti REALUS momentas.
 *
 * Jam skirtas atskiras failas ne dėl dydžio, o dėl to, kad tai vienintelė payload'o taisyklė,
 * kurios negali išspręsti forma: `2026-02-30T00:00:00Z` atitinka bet kokį protingą regexp'ą, o
 * variklio `Date.parse` jį TYLIAI perverčia į kovą — pranešimas atsirastų dviem dienom vėliau
 * už įvykį, apie kurį praneša. Todėl čia yra ir šimtmečio kėlinių, ir poslinkio kraštinės.
 */

test("an occurred-at that is not an ISO-8601 instant is refused", () => {
  for (const occurredAt of [
    "not a date",
    // Shaped like an instant, but no such calendar day exists. The engine's own
    // parser rolls the February ones over into March instead of refusing them.
    "2026-13-45T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-00-11T00:00:00Z",
    "2026-08-00T00:00:00Z",
    // Out-of-range time of day and offset.
    "2026-08-11T25:00:00Z",
    "2026-08-11T09:60:00Z",
    "2026-08-11T09:30:61Z",
    "2026-08-11T09:30:00+25:00",
    // A day is not an instant, and a local time has no offset to anchor it.
    "2026-08-11",
    "2026-08-11T09:30:00",
    "2026-08-11 09:30:00Z",
    "1775000000000",
    "",
    "Tue, 11 Aug 2026 09:30:00 GMT",
  ]) {
    assert.equal(parsePushNotification(delivery({ occurredAt })), null, occurredAt);
  }

  for (const occurredAt of [
    "2026-08-11T09:30:00Z",
    "2026-08-11T09:30:00.250Z",
    "2026-08-11T09:30:00+03:00",
    "2026-08-11T09:30:00-07:00",
    "2026-08-11T23:59:59Z",
    // A leap day in a leap year is a real instant and must survive the check.
    "2028-02-29T12:00:00Z",
  ]) {
    assert.equal(accepted({ occurredAt }).occurredAtLabel, occurredAt);
  }
});

test("the occurred-at calendar rules hold at the century and offset edges", () => {
  for (const occurredAt of [
    // A century year is a leap year only every four hundred years, and the
    // check has to answer that from the date itself.
    "2000-02-29T00:00:00Z",
    "2400-02-29T00:00:00Z",
    // The extreme real-world offsets, at both signs.
    "2026-08-11T09:30:00+14:00",
    "2026-08-11T09:30:00-14:00",
    "2026-08-11T09:30:00+00:00",
    // Sub-second precision the platform may abbreviate.
    "2026-08-11T09:30:00.1Z",
    "2026-08-11T09:30:00.12Z",
    "2026-08-11T09:30:00.123+14:00",
  ]) {
    assert.equal(accepted({ occurredAt }).occurredAtLabel, occurredAt);
  }

  for (const occurredAt of [
    // `% 100` without `% 400`: shaped like the accepted 2000 case, but no such
    // day exists, and the engine's own parser would roll it into March.
    "2100-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2200-02-29T00:00:00Z",
    // February never has thirty days, leap year or not.
    "2000-02-30T00:00:00Z",
    // Offsets past the bound, and an offset whose minutes are not minutes.
    "2026-08-11T09:30:00+15:00",
    "2026-08-11T09:30:00-15:00",
    "2026-08-11T09:30:00+14:60",
    "2026-08-11T09:30:00+1400",
    "2026-08-11T09:30:00+14",
    // A fraction is one to three digits, and never absent after its point.
    "2026-08-11T09:30:00.1234Z",
    "2026-08-11T09:30:00.Z",
  ]) {
    assert.equal(parsePushNotification(delivery({ occurredAt })), null, occurredAt);
  }
});
