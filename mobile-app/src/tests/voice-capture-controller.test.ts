import assert from "node:assert/strict";
import test from "node:test";
import { captureCode, fixture, fixtureSpeak, spokenText } from "./voice-capture-doubles.js";

/**
 * The one seam a recognised command can cross on its way to the host. Every test
 * here asks the same question from a different angle: could this transcript be
 * sent without the operator having read exactly it, once, on purpose?
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 601 eilutė). Čia — PATVIRTINIMO
 * SIŪLĖ. Laikymo ciklas, adapterio atsisakymai ir prieinamumas —
 * `voice-capture-lifecycle.test.ts`; bendra fikstūra — `voice-capture-doubles.ts`.
 */

test("a partial is never a transcript: nothing can be sent while the operator is still speaking", async () => {
  const { speech, terminal, controller, events, types } = fixture();
  await controller.holdStarted();

  assert.ok(speech.onPartial, "the recogniser was given no partial callback");
  speech.onPartial({ text: spokenText, confidence: 0.99 });
  speech.onPartial({ text: `${spokenText} --watch`, confidence: 0.99 });

  assert.ok(types().includes("voice.partial"), "the partial never reached the Model");
  assert.equal(await captureCode(controller.confirm(spokenText)), "no-transcript");
  assert.equal(await captureCode(controller.confirm(`${spokenText} --watch`)), "no-transcript");
  assert.equal(terminal.submitted.length, 0);
  assert.ok(!types().includes("voice.transcribed"));
  assert.ok(!events.some((event) => event.type === "voice.cancelled"));
});

test("a transcript that changed after it was shown is refused instead of sent unseen", async () => {
  const { terminal, controller, types } = fixture();
  await fixtureSpeak(controller);

  assert.equal(await captureCode(controller.confirm("rm -rf /")), "transcript-changed");
  assert.equal(terminal.submitted.length, 0);
  assert.ok(types().includes("error"), "the operator was not told why nothing was sent");

  // The transcript itself survives: it is the screen that has to catch up.
  await controller.confirm(spokenText);
  assert.deepEqual(terminal.submitted, [spokenText]);
});

test("a double tap on send delivers the command exactly once", async () => {
  const { terminal, controller } = fixture();
  terminal.deferred = true;
  await fixtureSpeak(controller);

  const first = controller.confirm(spokenText);
  const second = captureCode(controller.confirm(spokenText));

  assert.equal(await second, "submit-in-flight");
  terminal.release();
  await first;
  assert.deepEqual(terminal.submitted, [spokenText]);
});

test("an uncertain transcript is not sendable until the operator has looked at it", async () => {
  for (const confidence of [0.1, null]) {
    const acknowledged = fixture();
    await acknowledged.speak({ text: spokenText, mode: "on-device", confidence });
    assert.equal(
      await captureCode(acknowledged.controller.confirm(spokenText)),
      "low-confidence-unconfirmed",
    );
    assert.equal(acknowledged.terminal.submitted.length, 0);

    acknowledged.controller.acknowledgeLowConfidence();
    await acknowledged.controller.confirm(spokenText);
    assert.deepEqual(acknowledged.terminal.submitted, [spokenText]);

    // Editing is itself the second look, so it clears the same gate.
    const edited = fixture();
    await edited.speak({ text: spokenText, mode: "on-device", confidence });
    edited.controller.edit(`${spokenText} --watch`);
    await edited.controller.confirm(`${spokenText} --watch`);
    assert.deepEqual(edited.terminal.submitted, [`${spokenText} --watch`]);
  }
});

test("what is sent is what the operator edited, never what the recogniser heard", async () => {
  const { terminal, controller, types } = fixture();
  await fixtureSpeak(controller);

  controller.edit("run the tests --watch");
  assert.ok(types().includes("voice.draft-edited"));

  // The recognised text is no longer the pending transcript, so confirming it
  // would be confirming something that is not on screen.
  assert.equal(await captureCode(controller.confirm(spokenText)), "transcript-changed");
  await controller.confirm("run the tests --watch");
  assert.deepEqual(terminal.submitted, ["run the tests --watch"]);
});

test("a transcript that failed to be delivered stays available to be sent again", async () => {
  const { terminal, controller, events, types } = fixture();
  await fixtureSpeak(controller);
  terminal.failNext = true;

  await assert.rejects(controller.confirm(spokenText), /gateway refused/);
  assert.deepEqual(terminal.submitted, [spokenText]);
  // Clearing the panel here would make the operator dictate the command again.
  assert.ok(types().includes("error"));
  assert.ok(!types().includes("voice.capture-failed"), "a delivery failure is not a capture failure");
  assert.ok(!types().includes("voice.cancelled"), "the reviewed transcript was thrown away");

  // The in-flight claim was released, so the retry is not refused as a double tap.
  await controller.confirm(spokenText);
  assert.deepEqual(terminal.submitted, [spokenText, spokenText]);
  assert.equal(events.filter((event) => event.type === "voice.cancelled").length, 1);
});

test("a delivered transcript leaves nothing behind that could be sent twice", async () => {
  const { terminal, controller, types } = fixture();
  await fixtureSpeak(controller);

  await controller.confirm(spokenText);
  assert.deepEqual(terminal.submitted, [spokenText]);
  assert.ok(types().includes("voice.cancelled"), "the review panel was not cleared");

  assert.equal(await captureCode(controller.confirm(spokenText)), "no-transcript");
  assert.deepEqual(terminal.submitted, [spokenText]);
});
