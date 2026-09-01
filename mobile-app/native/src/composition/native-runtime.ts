import type { AppProps } from "../App";
import type {
  AgLoopUiReadPort,
  HostConnectionsReadPort,
  ProjectsReadPort,
  SessionReviewReadPort,
} from "../core";
import type { MobileTerminalPorts } from "./create-app-runtime";

/**
 * Platform composition root of the native shell.
 *
 * `create-app-runtime.ts` builds the terminal runtime once `App` has a
 * dispatcher. This module sits one step earlier and answers the question the
 * Expo entry has to answer before React exists: which ports does THIS
 * installation have, and which host do they talk to. Before it existed the
 * entry registered `App` with no props at all, so no port could ever reach a
 * screen even after its adapter landed.
 *
 * Two responsibilities, and deliberately no third:
 *
 *  - the endpoint and the opened project/session come from configuration, so
 *    no host URL is compiled into a screen, a controller or an adapter;
 *  - every port it is handed reaches `App`, and every port it is not handed
 *    stays absent — the spaces then report what is missing instead of showing
 *    fabricated data or controls that lead nowhere.
 *
 * It constructs no port itself, and that is not an oversight. Each concrete
 * adapter needs a capability this package does not have yet: the gateway
 * client needs a `CredentialPort` and a device proof signer over the OS
 * keystore (task 119), the terminal write gate needs biometrics (task 120),
 * push-to-talk needs a recogniser (task 121), and the four read ports have no
 * adapter anywhere yet — an HTTP one belongs beside `gateway-http-client.ts`
 * in the platform-independent core, which owns the response validators. A
 * half-built copy of any of them here would put a transport in the shell and,
 * in the write gate's case, an unguarded path to the host in front of it.
 */

/**
 * Configuration of one installation.
 *
 * `EXPO_PUBLIC_*` is the only prefix Expo's Babel transform inlines into the
 * bundle, so reading it needs no new dependency and no runtime config fetch.
 *
 * Values are passed through verbatim: `GatewayHttpClient` and
 * `TerminalStreamClient` already refuse a URL whose scheme, host or path is
 * wrong, and a second copy of those rules here could only drift from the ones
 * that actually guard the wire. Empty and whitespace-only values collapse to
 * `null`, because "configured to nothing" and "not configured" must not be two
 * different states.
 */
export interface NativeShellConfig {
  /** Base URL the gateway adapters (task 119) are built on; `null` when unset. */
  readonly gatewayBaseUrl: string | null;
  /** Absolute terminal stream endpoint; without it no Terminal space is composed. */
  readonly terminalStreamUrl: string | null;
  /** Project the spaces open on; `null` lets the Projects space choose. */
  readonly projectId: string | null;
  /** Session the Review space opens on; `null` falls back to the live one. */
  readonly sessionId: string | null;
}

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The single configuration point of the native shell.
 *
 * Each variable is spelled out as a literal member access on purpose: Expo
 * inlines `process.env.EXPO_PUBLIC_X` only in that exact form, so a computed
 * lookup would compile and then read `undefined` on a device.
 */
export function readNativeShellConfig(): NativeShellConfig {
  return Object.freeze({
    gatewayBaseUrl: configured(process.env.EXPO_PUBLIC_VERQESTRA_GATEWAY_URL),
    terminalStreamUrl: configured(process.env.EXPO_PUBLIC_VERQESTRA_TERMINAL_STREAM_URL),
    projectId: configured(process.env.EXPO_PUBLIC_VERQESTRA_PROJECT_ID),
    sessionId: configured(process.env.EXPO_PUBLIC_VERQESTRA_SESSION_ID),
  });
}

/**
 * Terminal ports as a platform adapter can supply them: everything
 * {@link MobileTerminalPorts} declares except `streamUrl`. An adapter knows how
 * to speak to a host; WHICH host is an installation's answer, not an adapter's,
 * so the composition root keeps that one field.
 */
export type NativeTerminalPorts = Omit<MobileTerminalPorts, "streamUrl">;

/**
 * Every port the shell can be given. All optional, in the same direction as
 * {@link AppProps}: an absent port takes an ability away, it never relaxes a
 * guard.
 */
export interface NativeShellPorts {
  readonly agLoopReads?: AgLoopUiReadPort;
  readonly sessionReviewReads?: SessionReviewReadPort;
  readonly connectionsReads?: HostConnectionsReadPort;
  readonly projectsReads?: ProjectsReadPort;
  /** The complete terminal transport; a partial set composes no Terminal space. */
  readonly terminal?: NativeTerminalPorts;
}

/**
 * Terminal ports for `App`, or `undefined` when this installation cannot open a
 * terminal. An endpoint that was never configured is exactly as unusable as a
 * missing write gate, so both answer the same way rather than producing a
 * Terminal space whose first action fails.
 */
function terminalPorts(
  ports: NativeTerminalPorts | undefined,
  streamUrl: string | null,
): MobileTerminalPorts | undefined {
  if (!ports || streamUrl === null) return undefined;
  return Object.freeze({ ...ports, streamUrl });
}

/**
 * The props the Expo entry registers `App` with.
 *
 * Both arguments are injectable so a shell that builds its ports elsewhere —
 * and the tests — can compose without reaching for the environment.
 */
export function createNativeAppProps(
  ports: NativeShellPorts = {},
  config: NativeShellConfig = readNativeShellConfig(),
): AppProps {
  const terminal = terminalPorts(ports.terminal, config.terminalStreamUrl);
  return Object.freeze({
    ...(ports.agLoopReads ? { agLoopReads: ports.agLoopReads } : {}),
    ...(ports.sessionReviewReads ? { sessionReviewReads: ports.sessionReviewReads } : {}),
    ...(ports.connectionsReads ? { connectionsReads: ports.connectionsReads } : {}),
    ...(ports.projectsReads ? { projectsReads: ports.projectsReads } : {}),
    ...(terminal ? { terminal } : {}),
    ...(config.projectId === null ? {} : { projectId: config.projectId }),
    ...(config.sessionId === null ? {} : { sessionId: config.sessionId }),
  });
}
