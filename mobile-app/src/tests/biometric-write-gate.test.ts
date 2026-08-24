import assert from "node:assert/strict";
import test from "node:test";
import {
  BiometricGateError,
  BiometricWriteGate,
  defaultUnlockWindowMs,
  maximumUnlockWindowMs,
  minimumUnlockWindowMs,
} from "../adapters/biometrics/biometric-write-gate.js";
import type {
  BiometricAuthenticatorPort,
  BiometricUnlockOutcome,
  TerminalWriteAction,
} from "../model/ports.js";

const reasons: Readonly<Record<TerminalWriteAction, string>> = Object.freeze({
  start: "Confirm to start a terminal session",
  input: "Confirm to send this command",
  resize: "Confirm to resize the terminal",
  interrupt: "Confirm to interrupt the agent",
  terminate: "Confirm to stop the agent",
  close: "Confirm to close the session",
});

function fakeAuthenticator(script: {
  available?: boolean | (() => never);
  outcomes?: readonly BiometricUnlockOutcome[];
  throwOnAuthenticate?: boolean;
}): { port: BiometricAuthenticatorPort; prompts: string[]; availabilityChecks: number } {
  const prompts: string[] = [];
  let availabilityChecks = 0;
  let index = 0;
  return {
    port: {
      async isAvailable() {
        availabilityChecks += 1;
        if (typeof script.available === "function") script.available();
        return script.available === undefined ? true : script.available === true;
      },
      async authenticate(input) {
        prompts.push(input.reason);
        if (script.throwOnAuthenticate === true) throw new Error("prompt crashed");
        const outcomes = script.outcomes ?? ["unlocked"];
        const outcome = outcomes[Math.min(index, outcomes.length - 1)] as BiometricUnlockOutcome;
        index += 1;
        return outcome;
      },
    },
    prompts,
    get availabilityChecks() {
      return availabilityChecks;
    },
  };
}

function clock(): { now: () => number; advance(ms: number): void; set(ms: number): void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}

test("one confirmation covers a burst of writes, and the window never slides", async () => {
  const authenticator = fakeAuthenticator({});
  const time = clock();
  const gate = new BiometricWriteGate(authenticator.port, time.now, reasons);

  await gate.requireUnlock("start");
  assert.deepEqual(authenticator.prompts, [reasons.start]);

  time.advance(defaultUnlockWindowMs - 1);
  await gate.requireUnlock("input");
  await gate.requireUnlock("input");
  assert.equal(authenticator.prompts.length, 1, "an open window prompts no further");

  // Activity inside the window must not extend it: a phone taken while unlocked
  // cannot be held open by typing.
  time.advance(1);
  await gate.requireUnlock("input");
  assert.deepEqual(authenticator.prompts, [reasons.start, reasons.input]);
});

test("a clock moved backwards closes the window instead of appearing to extend it", async () => {
  const authenticator = fakeAuthenticator({});
  const time = clock();
  const gate = new BiometricWriteGate(authenticator.port, time.now, reasons);

  await gate.requireUnlock("start");
  time.set(1);
  await gate.requireUnlock("input");
  assert.equal(authenticator.prompts.length, 2);
});

test("locking forces the next write to be confirmed again", async () => {
  const authenticator = fakeAuthenticator({});
  const gate = new BiometricWriteGate(authenticator.port, clock().now, reasons);

  await gate.requireUnlock("start");
  gate.lock();
  await gate.requireUnlock("close");
  assert.deepEqual(authenticator.prompts, [reasons.start, reasons.close]);
});

test("every outcome that is not an explicit unlock denies the write", async () => {
  const denials: ReadonlyArray<Exclude<BiometricUnlockOutcome, "unlocked">> = [
    "denied",
    "unavailable",
    "not-enrolled",
    "locked-out",
  ];
  for (const outcome of denials) {
    const authenticator = fakeAuthenticator({ outcomes: [outcome] });
    const gate = new BiometricWriteGate(authenticator.port, clock().now, reasons);
    await assert.rejects(
      gate.requireUnlock("input"),
      (error: unknown) => error instanceof BiometricGateError && error.outcome === outcome,
      outcome,
    );
    // A denial opens no window: the next write is prompted again.
    await assert.rejects(gate.requireUnlock("input"));
    assert.equal(authenticator.prompts.length, 2, outcome);
  }
});

test("an unusable authenticator denies without even prompting", async () => {
  for (const authenticator of [
    fakeAuthenticator({ available: false }),
    fakeAuthenticator({
      available: () => {
        throw new Error("biometric subsystem unavailable");
      },
    }),
  ]) {
    const gate = new BiometricWriteGate(authenticator.port, clock().now, reasons);
    await assert.rejects(
      gate.requireUnlock("start"),
      (error: unknown) => error instanceof BiometricGateError && error.outcome === "unavailable",
    );
    // Without biometrics there is no confirmation to obtain, so no prompt is
    // shown and, crucially, the write is refused rather than allowed.
    assert.deepEqual(authenticator.prompts, []);
  }
});

test("a prompt that crashes is a denial, never an implicit success", async () => {
  const authenticator = fakeAuthenticator({ throwOnAuthenticate: true });
  const gate = new BiometricWriteGate(authenticator.port, clock().now, reasons);

  await assert.rejects(
    gate.requireUnlock("terminate"),
    (error: unknown) => error instanceof BiometricGateError && error.outcome === "denied",
  );
  await assert.rejects(gate.requireUnlock("terminate"));
  assert.equal(authenticator.prompts.length, 2);
});

test("an adapter returning something outside the contract is still a denial", async () => {
  const rogue: BiometricAuthenticatorPort = {
    async isAvailable() {
      return true;
    },
    async authenticate() {
      // A native module that answers with anything else must not pass the gate.
      return "yes" as BiometricUnlockOutcome;
    },
  };
  const gate = new BiometricWriteGate(rogue, clock().now, reasons);
  await assert.rejects(
    gate.requireUnlock("input"),
    (error: unknown) => error instanceof BiometricGateError && error.outcome === "denied",
  );
});

test("a truthy but non-boolean availability answer is not treated as available", async () => {
  const rogue: BiometricAuthenticatorPort = {
    async isAvailable() {
      return "yes" as unknown as boolean;
    },
    async authenticate() {
      return "unlocked";
    },
  };
  const gate = new BiometricWriteGate(rogue, clock().now, reasons);
  await assert.rejects(
    gate.requireUnlock("input"),
    (error: unknown) => error instanceof BiometricGateError && error.outcome === "unavailable",
  );
});

test("the unlock window has to stay inside its bounds", () => {
  const authenticator = fakeAuthenticator({});
  const time = clock();
  for (const invalid of [
    0,
    minimumUnlockWindowMs - 1,
    maximumUnlockWindowMs + 1,
    1.5,
    Number.NaN,
  ]) {
    assert.throws(
      () => new BiometricWriteGate(authenticator.port, time.now, reasons, invalid),
      RangeError,
      `${invalid}`,
    );
  }
  assert.ok(new BiometricWriteGate(authenticator.port, time.now, reasons, minimumUnlockWindowMs));
  assert.ok(new BiometricWriteGate(authenticator.port, time.now, reasons, maximumUnlockWindowMs));
  assert.ok(defaultUnlockWindowMs <= maximumUnlockWindowMs);
});
