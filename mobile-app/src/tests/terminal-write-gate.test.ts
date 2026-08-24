import assert from "node:assert/strict";
import test from "node:test";
import {
  terminalInputCharacterLimit,
  TerminalApplicationError,
  TerminalController,
} from "../controller/terminal-controller.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState } from "../model/state.js";
import {
  deviceId,
  fixture,
  geometry,
  projectId,
  session,
  sessionId,
  streamUrl,
  terminalStates,
} from "./terminal-controller-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `terminal-controller-doubles.ts`). Čia —
 * PATVIRTINIMO VARTAS: kuris veiksmas jo prašo, kuris neturi teisės, ir kas lieka, kai
 * patvirtinimo nebėra. Gyvenimo ciklas — `terminal-controller.test.ts`.
 *
 * Paskutinis testas fikstūros NENAUDOJA sąmoningai: jam reikia vartų, kurie atsakymą keičia
 * VIDURYJE sesijos, o bendra fikstūra vartą fiksuoja konstrukcijos metu. Perdaryti ją į
 * kintamą reikštų suteikti visiems kitiems testams galimybę tyliai persijungti.
 */

test("every host mutation asks for confirmation, and reads never do", async () => {
  const value = fixture();
  await value.controller.start({ projectId, provider: "codex", ...geometry });
  await value.controller.submitKeyboard("pnpm test");
  await value.controller.submitConfirmedVoice("fix it");
  await value.controller.resize(120, 40);
  await value.controller.interrupt();
  await value.controller.terminate();
  await value.controller.close();

  assert.deepEqual(value.unlockRequests, [
    "start",
    "input",
    "input",
    "resize",
    "interrupt",
    "terminate",
    "close",
  ]);
  // A closed session must not lend its confirmation window to the next one.
  assert.equal(value.gateLocks, 1);

  // Reads carry no host effect, so they must never cost a prompt.
  const reader = fixture();
  await reader.controller.start({ projectId, provider: "codex", ...geometry });
  await reader.controller.refreshSnapshot();
  reader.controller.detachStream();
  assert.deepEqual(reader.unlockRequests, ["start"]);
  // Detaching is the operator stepping away: the confirmation window must not
  // survive it, or whoever holds the phone next writes unprompted.
  assert.equal(reader.gateLocks, 1);
});

test("a denied confirmation blocks every write and leaves the session untouched", async () => {
  const value = fixture({ lockedGate: true });

  await assert.rejects(
    value.controller.start({ projectId, provider: "codex", ...geometry }),
    (error: unknown) => error instanceof TerminalApplicationError &&
      error.code === "unlock_required",
  );
  // Nothing was created, so nothing may be reported as creating or failed.
  assert.deepEqual(terminalStates(value.events), []);
  assert.deepEqual(value.gatewayCalls, []);
  assert.equal(value.state.error, "Biometric confirmation is required.");
  assert.equal(value.controller.session, undefined);

  // The refusal is not a stuck start: a device whose biometrics come back can
  // start immediately, with no restart in between.
  const recovered = fixture();
  await recovered.controller.start({ projectId, provider: "codex", ...geometry });
  assert.equal(recovered.state.terminalState, "live");
});

test("invalid input is refused before it can cost a confirmation prompt", async () => {
  const value = fixture();
  await value.controller.start({ projectId, provider: "codex", ...geometry });

  for (const rejected of ["", "x".repeat(terminalInputCharacterLimit + 1)]) {
    await assert.rejects(value.controller.submitKeyboard(rejected));
  }
  assert.deepEqual(value.unlockRequests, ["start"]);
});

test("a confirmation lost mid-session stops writes without ending the session", async () => {
  let locked = false;
  const gatewayCalls: string[] = [];
  const events: AppEvent[] = [];
  let state = initialAppState;
  const controller = new TerminalController(
    {
      async createTerminalSession() {
        gatewayCalls.push("create");
        return session();
      },
      async getTerminalSession() {
        gatewayCalls.push("get");
        return session();
      },
      async writeTerminalInput() {
        gatewayCalls.push("input");
        return { inputId: "123e4567-e89b-42d3-a456-426614174034", status: "accepted" };
      },
      async resizeTerminal() {
        gatewayCalls.push("resize");
      },
      async signalTerminal() {
        gatewayCalls.push("signal");
        return undefined;
      },
      async closeTerminal() {
        gatewayCalls.push("close");
        return session("ended");
      },
    },
    {
      async loadDeviceCredential() {
        return {
          deviceId,
          generation: 1,
          accessToken: "access.token",
          accessExpiresAt: "2026-07-26T12:15:00.000Z",
          refreshToken: "refresh-token-value-0001",
          refreshExpiresAt: "2026-08-25T12:00:00.000Z",
        };
      },
      async storeDeviceCredential() {},
      async clearDeviceCredential() {},
    },
    { start() {}, stop() {} },
    streamUrl,
    (event) => {
      events.push(event);
      state = reduceAppState(state, event);
    },
    {
      async requireUnlock() {
        if (locked) throw new Error("biometric lockout");
      },
      lock() {},
    },
  );

  await controller.start({ projectId, provider: "codex", ...geometry });
  locked = true;

  for (const attempt of [
    () => controller.submitKeyboard("rm -rf /"),
    () => controller.resize(120, 40),
    () => controller.interrupt(),
    () => controller.terminate(),
    () => controller.close(),
  ]) {
    await assert.rejects(
      attempt(),
      (error: unknown) => error instanceof TerminalApplicationError &&
        error.code === "unlock_required",
    );
  }
  // Not one write reached the host, and the session is still there to be
  // closed once the operator can confirm again.
  assert.deepEqual(gatewayCalls, ["create"]);
  assert.equal(state.terminalState, "live");
  assert.equal(controller.session?.sessionId, sessionId);

  // A read still works while writes are locked out.
  await controller.refreshSnapshot();
  assert.deepEqual(gatewayCalls, ["create", "get"]);
});
