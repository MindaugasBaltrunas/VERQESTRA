import type {
  CredentialPort,
  GatewayPort,
  TerminalSession,
  TerminalWriteAction,
  TerminalWriteGatePort,
} from "../model/ports.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState } from "../model/state.js";
import { TerminalController, type TerminalStreamControlPort } from "../controller/terminal-controller.js";

/**
 * Shared doubles for the terminal controller suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `terminal-controller.test.ts` buvo 686
 * eilučių). Fikstūra atskirai, nes `fixture()` yra vienintelis apibrėžimas, ką reiškia
 * „paleistas kontroleris": jame yra ir `unlockRequests`, ir `gateLocks`, t. y. būtent tai,
 * kuo patvirtinimo vartų rinkinys ir gyvenimo ciklo rinkinys tvirtina PRIEŠINGUS dalykus.
 * Dvi kopijos leistų vienai nustoti skaičiuoti raktus, ir „nė vienas rašymas nepasiekė host'o"
 * praeitų tuščiai.
 */

export const projectId = "123e4567-e89b-42d3-a456-426614174030";
export const sessionId = "123e4567-e89b-42d3-a456-426614174031";
export const deviceId = "123e4567-e89b-42d3-a456-426614174032";
export const leaseId = "123e4567-e89b-42d3-a456-426614174033";
export const streamUrl = "wss://pc.private.test/v1/terminal-stream";

export const geometry = { cols: 100, rows: 30 } as const;

export function session(state: TerminalSession["state"] = "live"): TerminalSession {
  return {
    sessionId,
    projectId,
    provider: "codex",
    workspaceMode: "isolated-worktree",
    branch: `mobile/${sessionId}`,
    state,
    lease: {
      leaseId,
      ownerDeviceId: deviceId,
      generation: 1,
      expiresAt: "2026-07-26T12:05:00.000Z",
    },
    nextSequence: 1,
  };
}

export type FixtureOverrides = Readonly<{
  gateway?: Partial<GatewayPort>;
  /** `null` models a device that lost its pairing between start and stream. */
  credential?: Awaited<ReturnType<CredentialPort["loadDeviceCredential"]>>;
  /** Denies every confirmation, modelling absent or refused biometrics. */
  lockedGate?: boolean;
}>;

export type Fixture = {
  controller: TerminalController;
  gatewayCalls: Array<{ name: string; input: unknown }>;
  streamStarts: unknown[];
  /** Every dispatched event, in order: state alone hides the transitions. */
  events: AppEvent[];
  unlockRequests: TerminalWriteAction[];
  get gateLocks(): number;
  get streamStops(): number;
  get state(): typeof initialAppState;
};

export function fixture(overrides: FixtureOverrides = {}): Fixture {
  const gatewayCalls: Array<{ name: string; input: unknown }> = [];
  const streamStarts: unknown[] = [];
  const events: AppEvent[] = [];
  const unlockRequests: TerminalWriteAction[] = [];
  let gateLocks = 0;
  let streamStops = 0;
  let state = initialAppState;
  const defaultGateway: GatewayPort = {
    async createTerminalSession(input) {
      gatewayCalls.push({ name: "create", input });
      return session();
    },
    async getTerminalSession(input) {
      gatewayCalls.push({ name: "get", input });
      return session();
    },
    async writeTerminalInput(input) {
      gatewayCalls.push({ name: "input", input });
      return {
        inputId: "123e4567-e89b-42d3-a456-426614174034",
        status: "accepted",
      };
    },
    async resizeTerminal(input) {
      gatewayCalls.push({ name: "resize", input });
    },
    async signalTerminal(input) {
      gatewayCalls.push({ name: "signal", input });
      return input.signal === "terminate" ? session("ended") : undefined;
    },
    async closeTerminal(input) {
      gatewayCalls.push({ name: "close", input });
      return session("ended");
    },
  };
  const gateway: GatewayPort = { ...defaultGateway, ...overrides.gateway };
  const credentials: CredentialPort = {
    async loadDeviceCredential() {
      return overrides.credential === undefined
        ? {
          deviceId,
          generation: 1,
          accessToken: "access.token.signature-value",
          accessExpiresAt: "2026-07-26T12:15:00.000Z",
          refreshToken: "refresh-token-value-0001",
          refreshExpiresAt: "2026-08-25T12:00:00.000Z",
        }
        : overrides.credential;
    },
    async storeDeviceCredential() {},
    async clearDeviceCredential() {},
  };
  const stream: TerminalStreamControlPort = {
    start(input) {
      streamStarts.push(input);
    },
    stop() {
      streamStops += 1;
    },
  };
  const writeGate: TerminalWriteGatePort = {
    async requireUnlock(action) {
      unlockRequests.push(action);
      if (overrides.lockedGate === true) throw new Error("biometric denied");
    },
    lock() {
      gateLocks += 1;
    },
  };
  return {
    controller: new TerminalController(
      gateway,
      credentials,
      stream,
      streamUrl,
      (event) => {
        events.push(event);
        state = reduceAppState(state, event);
      },
      writeGate,
    ),
    gatewayCalls,
    streamStarts,
    events,
    unlockRequests,
    get gateLocks() {
      return gateLocks;
    },
    get streamStops() {
      return streamStops;
    },
    get state() {
      return state;
    },
  };
}

/** Terminal states in dispatch order; the events themselves hide no transition. */
export function terminalStates(events: readonly AppEvent[]): string[] {
  return events
    .filter((event): event is Extract<AppEvent, { type: "terminal.state" }> =>
      event.type === "terminal.state")
    .map((event) => event.state);
}
