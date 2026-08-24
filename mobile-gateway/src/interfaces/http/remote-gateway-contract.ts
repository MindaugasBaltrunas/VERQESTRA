import type { AuditAction } from "../../application/ports/audit-port.js";

/**
 * Nuotolinio šliuzo KONTRAKTAS: klaidų žodynas, maršrutų paviršius, užklausos/atsakymo formos
 * ir vokų statytojai.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `remote-gateway-router.ts` buvo 1319 eilučių).
 * Pjūvis toks pat kaip vietiniame kanale: čia — kas yra teisėta forma ir kokiu voku pakuojama;
 * `remote-gateway-router.ts` — kokia tvarka sprendžiama. Šiame faile nėra nė vienos funkcijos,
 * kuri siektų servisą ar turėtų būseną, todėl jį gali importuoti ir transportas
 * (`tls-gateway-server`, `terminal-websocket-gateway`) neužsitraukdamas viso maršrutizatoriaus.
 */

export const MAX_HTTP_BODY_BYTES = 32 * 1024;

/**
 * Every error code the gateway may return. This is the single source of truth
 * shared with `api-contract.yaml`; `api-contract-conformance.test.ts` fails if
 * the OpenAPI `ErrorEnvelope` enum and this list drift apart.
 */
export const GATEWAY_ERROR_CODES = Object.freeze([
  "unauthenticated",
  "forbidden",
  "invalid_request",
  "not_found",
  "project_not_found",
  "host_busy",
  "stale_terminal_lease",
  "duplicate_request",
  "ag_loop_ui_offline",
  "session_not_live",
  "history_truncated",
  "rate_limited",
  "conflict",
  "internal_error",
] as const);

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/**
 * The one HTTP status each error code is answered with.
 *
 * `Record<GatewayErrorCode, number>` is what makes the mapping total: a code
 * added to {@link GATEWAY_ERROR_CODES} without a status here does not compile.
 * `errorResponse` reads this table rather than accepting a status argument, so
 * two routes cannot answer the same code with different statuses.
 *
 * `history_truncated` has no HTTP producer — it belongs to the terminal stream
 * vocabulary — but the type demands an entry, and 409 is the honest one: the
 * replay window is gone and repeating the same request will not bring it back.
 */
export const GATEWAY_STATUS_BY_CODE: Readonly<Record<GatewayErrorCode, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  project_not_found: 404,
  host_busy: 409,
  stale_terminal_lease: 409,
  duplicate_request: 409,
  session_not_live: 409,
  conflict: 409,
  history_truncated: 409,
  ag_loop_ui_offline: 503,
  rate_limited: 429,
  internal_error: 500,
});

/**
 * Whether repeating the same request could plausibly succeed.
 *
 * `internal_error` is recoverable everywhere, including the unclassified 500 at
 * the end of the error mapping: an unclassified fault is precisely the case in
 * which retrying is the only useful thing a client can do, and the caller's
 * `Idempotency-Key` plus the supervisor's own identity ledgers make that retry
 * side-effect free.
 */
export const GATEWAY_RECOVERABLE_BY_CODE: Readonly<Record<GatewayErrorCode, boolean>> = Object.freeze({
  unauthenticated: true,
  forbidden: false,
  invalid_request: true,
  not_found: false,
  project_not_found: false,
  host_busy: true,
  stale_terminal_lease: true,
  duplicate_request: false,
  session_not_live: true,
  conflict: true,
  history_truncated: false,
  ag_loop_ui_offline: true,
  rate_limited: true,
  internal_error: true,
});

/**
 * Declarative surface of every route the gateway serves, in OpenAPI template
 * form. It is asserted against both `api-contract.yaml` and the live router, so
 * an undeclared route cannot be added and a declared route cannot rot.
 */
export const GATEWAY_ROUTE_SURFACE = Object.freeze([
  { method: "POST", template: "/v1/pairing-challenges/{challengeId}/redeem" },
  { method: "POST", template: "/v1/auth/refresh" },
  { method: "GET", template: "/v1/connections/github" },
  { method: "GET", template: "/v1/projects" },
  { method: "GET", template: "/v1/projects/{projectId}/github" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/dashboard" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/tasks" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/logs" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/events" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/policy-controls" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/learning" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/token-usage" },
  { method: "GET", template: "/v1/projects/{projectId}/ag-loop/ui/token-analytics" },
  { method: "POST", template: "/v1/projects/{projectId}/terminal-sessions" },
  { method: "GET", template: "/v1/projects/{projectId}/terminal-sessions/{sessionId}" },
  { method: "POST", template: "/v1/projects/{projectId}/terminal-sessions/{sessionId}/input" },
  { method: "POST", template: "/v1/projects/{projectId}/terminal-sessions/{sessionId}/resize" },
  { method: "POST", template: "/v1/projects/{projectId}/terminal-sessions/{sessionId}/signal" },
  { method: "POST", template: "/v1/projects/{projectId}/terminal-sessions/{sessionId}/close" },
  { method: "POST", template: "/v1/projects/{projectId}/terminal-sessions/{sessionId}/lease" },
] as const);

export type GatewayHttpRequest = Readonly<{
  method: string;
  path: string;
  headers?: Readonly<Record<string, string | undefined>>;
  body?: string | Uint8Array;
  /**
   * Transport-supplied peer address. The router never derives it from a
   * forwarded header, which a remote caller controls, so an attacker cannot
   * rotate the rate-limit key from the request body or headers.
   */
  remoteAddress?: string;
}>;

export type GatewayHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  /**
   * Frames of a streaming response, already formatted for the wire. When it is
   * present the transport writes these instead of `body`, which stays empty.
   * The router decides what a stream contains; the transport decides how bytes
   * reach the socket.
   */
  stream?: AsyncIterable<string>;
  /**
   * Called by the transport once the client is gone. It is what lets a
   * long-lived read release its upstream connection promptly instead of waiting
   * for the next frame to notice the socket died.
   */
  onClose?: () => void;
}>;

/** Identity collected while routing, so the audit record survives an early throw. */
export type AuditDraft = {
  action?: AuditAction;
  principalId?: string;
  deviceId?: string;
  projectId?: string;
  sessionId?: string;
  requestId?: string;
};

export class InvalidHttpRequestError extends Error {}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many attempts");
  }
}

/** An audit record could not be written for an action that requires one. */
export class AuditWriteError extends Error {}

export function responseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

export function eventStreamHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "text/event-stream; charset=utf-8",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  };
}

export function readResponse(body: Readonly<Record<string, unknown>>): GatewayHttpResponse {
  return { status: 200, headers: responseHeaders(), body };
}

/**
 * The single envelope builder. It takes no status and no recoverable flag on
 * purpose: a signature that still accepted them would be a signature that let
 * one route answer a code differently from another, and the tables above would
 * be documentation rather than the mechanism.
 */
export function errorResponse(
  code: GatewayErrorCode,
  message: string,
  correlationId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): GatewayHttpResponse {
  return {
    status: GATEWAY_STATUS_BY_CODE[code],
    headers: { ...responseHeaders(), ...extraHeaders },
    body: {
      error: {
        code,
        message,
        correlationId,
        recoverable: GATEWAY_RECOVERABLE_BY_CODE[code],
      },
    },
  };
}
