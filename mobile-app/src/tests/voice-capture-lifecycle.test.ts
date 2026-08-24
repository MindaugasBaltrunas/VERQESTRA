import assert from "node:assert/strict";
import test from "node:test";
import { SecureCloudConsentStore } from "../adapters/speech/cloud-consent-store.js";
import type { SpeechCapability } from "../model/ports.js";
import {
  availabilityEvents,
  captureCode,
  cloudCapability,
  consentEvents,
  consentKey,
  fixture,
  flush,
  spokenText,
  UnprobeableRecorder,
} from "./voice-capture-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `voice-capture-doubles.ts`). Čia — LAIKYMO CIKLAS
 * ir ĮRENGINYS: kas nutinka atsakymui, atėjusiam per vėlai, kaip adapterio atsisakymas virsta
 * ekrano žodžiais, ir ką pranešama apie prieinamumą bei sutikimą. Patvirtinimo siūlė —
 * `voice-capture-controller.test.ts`.
 */

test("leaving while the recogniser is starting never shows a screen that is listening", async () => {
  const { speech, controller, types } = fixture();
  speech.deferStart = true;

  const holding = controller.holdStarted();
  await flush();
  assert.equal(speech.starts, 1);

  controller.cancel();
  speech.releaseStart();
  await holding;

  assert.ok(!types().includes("voice.capture-started"), "the screen claimed to be listening");
  assert.ok(types().includes("voice.cancelled"));
  assert.equal(speech.cancels, 1, "the late capture was left running");
});

test("a final that lands after the capture was discarded strands no transcript", async () => {
  const { speech, terminal, controller, types } = fixture();
  speech.deferStop = true;

  await controller.holdStarted();
  const ending = controller.holdEnded();
  await flush();
  controller.cancel();
  speech.releaseStop();
  await ending;

  assert.ok(!types().includes("voice.transcribed"), "a discarded capture produced a transcript");
  assert.equal(await captureCode(controller.confirm(spokenText)), "no-transcript");
  assert.equal(terminal.submitted.length, 0);

  // And the next press really records, instead of being refused because of a
  // transcript the screen offers no way to discard.
  speech.deferStop = false;
  await controller.holdStarted();
  assert.equal(speech.starts, 2, "the next hold never reached the recogniser");
  assert.ok(
    !types().includes("error"),
    "the operator was told to confirm a transcript that does not exist",
  );
});

test("a final belonging to an older hold cannot become the new hold's transcript", async () => {
  const { speech, terminal, controller, types } = fixture();
  speech.deferStop = true;

  await controller.holdStarted();
  const ending = controller.holdEnded();
  await flush();

  // A new press arrives while the previous capture is still finalising.
  await controller.holdStarted();
  speech.releaseStop();
  await ending;

  assert.ok(!types().includes("voice.transcribed"), "the stale final was adopted");
  assert.equal(await captureCode(controller.confirm(spokenText)), "no-transcript");
  assert.equal(terminal.submitted.length, 0);
});

test("a release without a press does nothing at all", async () => {
  const { speech, controller, events } = fixture();

  await controller.holdEnded();

  assert.deepEqual(events, []);
  assert.equal(speech.starts, 0);
  assert.equal(speech.stops, 0);
  assert.equal(speech.cancels, 0);
});

test("two press events in the same tick open one capture", async () => {
  const { speech, controller, types } = fixture();
  speech.deferStart = true;

  const first = controller.holdStarted();
  const second = controller.holdStarted();
  await flush();
  assert.equal(speech.starts, 1);

  speech.releaseStart();
  await Promise.all([first, second]);

  assert.equal(speech.starts, 1);
  assert.equal(types().filter((type) => type === "voice.capture-requested").length, 1);
  assert.equal(types().filter((type) => type === "voice.capture-started").length, 1);
});

test("a press released before the recogniser was listening produces no transcript", async () => {
  const { speech, terminal, controller, types } = fixture();
  speech.deferStart = true;

  const holding = controller.holdStarted();
  await flush();
  await controller.holdEnded();
  speech.releaseStart();
  await holding;

  assert.ok(!types().includes("voice.capture-started"));
  assert.ok(!types().includes("voice.transcribed"));
  assert.ok(types().includes("voice.cancelled"));
  assert.equal(await captureCode(controller.confirm(spokenText)), "no-transcript");
  assert.equal(terminal.submitted.length, 0);
});

test("a recogniser that fails to finalise reports a capture failure and keeps no transcript", async () => {
  const { speech, terminal, controller, events } = fixture();
  speech.stopError = new Error("recogniser crashed while finalising");

  await controller.holdStarted();
  await controller.holdEnded();

  const failures = events.filter((event) => event.type === "voice.capture-failed");
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], { type: "voice.capture-failed", failure: "recognizer-failed" });
  assert.equal(await captureCode(controller.confirm(spokenText)), "no-transcript");
  assert.equal(terminal.submitted.length, 0);
});

test("every adapter refusal reaches the screen as a reason it can word", async () => {
  const cases: ReadonlyArray<Readonly<{
    capability?: SpeechCapability;
    startError?: unknown;
    failure: string;
  }>> = [
    {
      capability: { available: false, mode: "on-device", reason: "unsupported", onDeviceSupported: false },
      failure: "unavailable",
    },
    {
      capability: {
        available: false,
        mode: "on-device",
        reason: "permission-denied",
        onDeviceSupported: true,
      },
      failure: "permission-denied",
    },
    { capability: cloudCapability, failure: "consent-required" },
    { startError: { code: "permission-denied" }, failure: "permission-denied" },
    { startError: new Error("microphone is busy"), failure: "recognizer-failed" },
  ];

  for (const scenario of cases) {
    const { speech, controller, events } = fixture();
    if (scenario.capability !== undefined) speech.capability = scenario.capability;
    if (scenario.startError !== undefined) speech.startError = scenario.startError;

    await controller.holdStarted();

    const failures = events.filter((event) => event.type === "voice.capture-failed");
    assert.deepEqual(
      failures,
      [{ type: "voice.capture-failed", failure: scenario.failure }],
      scenario.failure,
    );
  }
});

test("a hold the recogniser is still holding returns the screen to idle, not to a failure", async () => {
  const { speech, recorder, controller, types } = fixture();
  // The adapter is already holding a capture this controller knows nothing
  // about, so its own `beginHold` is refused as `hold-in-progress`.
  await recorder.beginHold({ locale: "en-US", onPartial: () => undefined });
  assert.equal(speech.starts, 1);

  await controller.holdStarted();

  assert.ok(!types().includes("voice.capture-failed"), "a dropped hold was reported as a fault");
  assert.ok(types().includes("voice.cancelled"));

  // And the next press works once the adapter is free again.
  await recorder.cancelHold();
  await controller.holdStarted();
  assert.equal(speech.starts, 2);
  assert.ok(types().includes("voice.capture-started"));
});

test("a device that cannot even be probed is reported as unusable, and refreshing never rejects", async () => {
  const { store, controller, events } = fixture({
    recorder: (speech, memory) => new UnprobeableRecorder(speech, new SecureCloudConsentStore(memory)),
  });
  // A recorded grant must not leak into the answer for a device that answered
  // nothing at all.
  store.values.set(consentKey, "granted");

  await assert.doesNotReject(controller.refreshAvailability());

  assert.deepEqual(availabilityEvents(events), [{
    type: "voice.availability",
    availability: "unavailable",
    mode: "cloud",
    reason: "unsupported",
    cloudConsent: false,
  }]);
});

test("availability reports the consent that is stored, not one inferred from the reason", async () => {
  const withGrant = fixture();
  withGrant.store.values.set(consentKey, "granted");
  await withGrant.controller.refreshAvailability();

  assert.deepEqual(availabilityEvents(withGrant.events), [{
    type: "voice.availability",
    availability: "available",
    mode: "on-device",
    reason: null,
    // The device transcribes on-device for reasons that say nothing about
    // cloud consent; the grant on screen is the grant in the keystore.
    cloudConsent: true,
  }]);

  const withoutGrant = fixture();
  await withoutGrant.controller.refreshAvailability();
  assert.deepEqual(availabilityEvents(withoutGrant.events), [{
    type: "voice.availability",
    availability: "available",
    mode: "on-device",
    reason: null,
    cloudConsent: false,
  }]);
});

test("withdrawing consent reports what was actually stored, and blocks the cloud again", async () => {
  const { speech, store, controller, events } = fixture();
  speech.capability = cloudCapability;

  await controller.setCloudConsent(true);
  assert.equal(store.values.get(consentKey), "granted");

  await controller.setCloudConsent(false);
  assert.equal(store.values.has(consentKey), false);

  assert.deepEqual(consentEvents(events).map((event) => event.granted), [true, false]);
  const availability = availabilityEvents(events);
  assert.deepEqual(availability.at(0), {
    type: "voice.availability",
    availability: "available",
    mode: "cloud",
    reason: null,
    cloudConsent: true,
  });
  assert.deepEqual(availability.at(-1), {
    type: "voice.availability",
    availability: "unavailable",
    mode: "cloud",
    reason: "consent-required",
    cloudConsent: false,
  });
});
