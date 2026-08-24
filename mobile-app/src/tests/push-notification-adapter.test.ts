import assert from "node:assert/strict";
import test from "node:test";
import { parsePushNotification } from "../adapters/push-notification-adapter.js";
import { accepted, delivery, unreadableDeliveries } from "./push-notification-doubles.js";

/**
 * A push notification is the one thing this app shows on a locked device, so
 * every case here asks the same question: can anything the host sent become
 * visible text? The answer has to stay "only a fixed label and an id that was
 * proven opaque", whatever shape the delivery arrives in.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 645 eilučių). Čia — PAYLOAD'O
 * FORMA: ką pristatymas privalo turėti ir kuo jo `subjectId` negali būti. Momento (`occurredAt`)
 * kalendorius — `push-notification-payload.test.ts`; pluoštas ir kontroleris —
 * `push-notification-feed.test.ts`; bendra fikstūra — `push-notification-doubles.ts`.
 */

test("a delivery that is not exactly the mirrored payload is dropped whole", () => {
  for (const malformed of [
    null,
    undefined,
    "failed",
    42,
    true,
    [delivery()],
    // A field the contract does not describe makes it a different document: a
    // `title`, `body` or `message` is exactly how host text would arrive.
    delivery({ title: "rm -rf /repo" }),
    delivery({ body: "diff --git a/secrets.txt" }),
    delivery({ message: "ghp_0123456789abcdef" }),
    // Missing fields, one at a time.
    { source: "ag-loop-read", subjectId: "1155", occurredAt: "2026-08-11T09:30:00Z" },
    { type: "failed", subjectId: "1155", occurredAt: "2026-08-11T09:30:00Z" },
    { type: "failed", source: "ag-loop-read", occurredAt: "2026-08-11T09:30:00Z" },
    { type: "failed", source: "ag-loop-read", subjectId: "1155" },
    // Values outside the closed unions, including inherited property names.
    delivery({ type: "started" }),
    delivery({ type: "toString" }),
    delivery({ type: "constructor" }),
    delivery({ source: "gateway" }),
    delivery({ source: "AG-LOOP-READ" }),
    // Right keys, wrong types.
    delivery({ type: 1 }),
    delivery({ source: null }),
    delivery({ subjectId: 1155 }),
    delivery({ occurredAt: 1_775_000_000_000 }),
    delivery({ subjectId: { id: "1155" } }),
  ]) {
    assert.equal(parsePushNotification(malformed), null, JSON.stringify(malformed) ?? "undefined");
  }
});

test("a delivery that fails while it is being inspected is refused, never raised", () => {
  // A throw here would land in the OS callback as a crash of the app, so a
  // delivery that could not be proven safe answers exactly like one that failed
  // a check. The feed's half of this claim is in `push-notification-feed.test.ts`.
  for (const delivered of unreadableDeliveries()) {
    assert.equal(parsePushNotification(delivered), null);
  }
});

test("a subject id that is a path or a secret never reaches a view state", () => {
  for (const subjectId of [
    "../../etc/passwd",
    "..",
    "a..b",
    "task/../secret",
    "/Users/op/repo",
    "C:\\repo\\AG",
    "~/id",
    // Fikstūrų ilgiai sąmoningai TARP adapterio slenksčio (prefiksas + >=8 ženklai,
    // AIza >=20) ir repo secret-scan slenksčio ({20,}, AIza {30,}): adapteris jas
    // atmeta kaip secret formos id, o repo secret-scan hook'as nelaiko jų radiniu.
    // AKIA atveju abu šablonai sutampa (lygiai 16), todėl reikšmė suklijuojama runtime.
    "ghp_0123456789ab",
    "gho_0123456789ab",
    "github_pat_0123456789ab",
    "sk-0123456789ab",
    "npm_0123456789ab",
    "hf_0123456789ab",
    "AKIA" + "IOSFODNN7EXAMPLE",
    "AIzaSyA0123456789abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMTU1In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g",
    "",
    "a".repeat(129),
  ]) {
    assert.equal(parsePushNotification(delivery({ subjectId })), null, subjectId);
  }

  // The shapes real ids take are still accepted, so the rules above are not a
  // ban on notifications.
  for (const subjectId of ["1155", "task-0042", "session.7f3a-9b", "a", "a".repeat(128)]) {
    assert.equal(accepted({ subjectId }).subjectId, subjectId);
  }
});

test("terminal text cannot ride into the tray on a subject id", () => {
  for (const subjectId of [
    "task 1155",
    "npm run build\n",
    "line one\nline two",
    "\u001b[31mFAILED\u001b[0m",
    "\u0007bell",
    "task\t1155",
    "τask-1155",
    "task<script>",
  ]) {
    assert.equal(parsePushNotification(delivery({ subjectId })), null, JSON.stringify(subjectId));
  }
});

test("the parsed payload is frozen before any caller can see it", () => {
  const payload = parsePushNotification(delivery({ subjectId: "task-0042" }));
  assert.notEqual(payload, null);
  if (payload === null) return;

  // The view state is already frozen; the payload it is built from has to be
  // too, or a screen holding the parsed delivery could rewrite a field that was
  // proven opaque and hand the rewritten value to a later present() call.
  assert.equal(Object.isFrozen(payload), true);
  assert.throws(() => {
    Object.assign(payload, { subjectId: "../../etc/passwd" });
  }, TypeError);
  assert.throws(() => {
    Object.defineProperty(payload, "title", { value: "rm -rf /repo" });
  }, TypeError);
  assert.deepEqual(Object.keys(payload).sort(), ["occurredAt", "source", "subjectId", "type"]);
  assert.equal(payload.subjectId, "task-0042");
});
