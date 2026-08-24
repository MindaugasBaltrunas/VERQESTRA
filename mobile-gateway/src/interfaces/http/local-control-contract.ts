import { LocalControlError, type LocalControlErrorCode } from "../../application/local-control-errors.js";
import type { AuditAction } from "../../application/ports/audit-port.js";
import type {
  LocalControlRequest,
  LocalControlResponse,
} from "../../application/ports/local-control-listener-port.js";
import type { LocalControlActor } from "../../application/local-integration-service.js";

/**
 * Vietinio kanalo KONTRAKTAS: paviršius, atsakymų formos, laukų validatoriai ir maršruto
 * atpažinimas.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `local-control-router.ts` buvo 625 eilutės).
 * Pjūvis vienas: čia — kas yra teisėta forma; ten — kokia tvarka sprendžiama ir kas įvykdoma.
 * Nė viena šio failo funkcija nesiekia serviso ir neturi būsenos.
 *
 * NUKRYPIMAS (formos, ne elgesio): prieiga prie neparsinto JSON kūno laukų eina per bracket,
 * o ne per tašką — `noPropertyAccessFromIndexSignature`. Taisyklė čia net naudinga: `value`
 * yra `Record<string, unknown>`, tad nė vienas laukas dar nėra įrodytas egzistuojančiu.
 */

export const MAX_LOCAL_BODY_BYTES = 32 * 1024;

/**
 * Declarative surface of the local channel, in the same template form the remote
 * surface uses. It exists so a test can assert the two never overlap.
 */
export const LOCAL_CONTROL_ROUTE_SURFACE = Object.freeze([
  { method: "POST", template: "/v1/local/pairing-challenges" },
  { method: "POST", template: "/v1/local/terminal-sessions/{sessionId}/force-close" },
  // Declared before the preview because that is the operator's real sequence:
  // run the gates, look at what would be integrated, then integrate.
  { method: "POST", template: "/v1/local/terminal-sessions/{sessionId}/gates" },
  { method: "POST", template: "/v1/local/terminal-sessions/{sessionId}/integration-preview" },
  { method: "POST", template: "/v1/local/terminal-sessions/{sessionId}/integrate" },
  { method: "POST", template: "/v1/local/devices/{deviceId}/revoke" },
] as const);

/** Identity collected while routing, so the audit record survives an early throw. */
export type LocalAuditDraft = {
  action?: AuditAction;
  sessionId?: string;
  deviceId?: string;
  requestId?: string;
};

/**
 * The local operation a request target names.
 *
 * Producing it is a pure read of the method and the path: no body is touched, no
 * parameter is trusted and no service is reached. That is what makes it safe to
 * do BEFORE admission, which in turn is what lets a refused caller still be
 * audited against the operation they aimed at.
 */
export type LocalRouteTarget = Readonly<{
  action: AuditAction;
  kind: "pairing-challenges" | "force-close" | "gates" | "integration-preview" | "integrate" | "revoke";
  /** Raw path parameter, still unvalidated. */
  parameter?: string;
}>;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_OID = /^[0-9a-f]{40}$/;
export const PROOF_HEADER_NAME = "x-ag-local-proof";
export const MAX_CONFIRMATION_LENGTH = 512;

const LOCAL_ROUTE =
  /^\/v1\/local\/(?:(pairing-challenges)|terminal-sessions\/([^/]+)\/(force-close|gates|integration-preview|integrate)|devices\/([^/]+)\/(revoke))$/;

/**
 * The audit action each session-scoped path segment names.
 *
 * A frozen map rather than the nested ternaries this used to be: `satisfies
 * Record<string, AuditAction>` makes a mistyped action a compile error, and the
 * lookup below is deliberately partial so that the one thing the type system
 * cannot check — that this table and the regex alternation above list the same
 * segments — fails as "no such route" rather than as an audit record with no
 * action in it.
 */
const SESSION_ACTIONS = Object.freeze({
  "force-close": "local.terminal.force_close",
  gates: "local.gates.run",
  "integration-preview": "local.integration.preview",
  integrate: "local.integration.confirm",
} as const satisfies Record<string, AuditAction>);

type SessionActionSegment = keyof typeof SESSION_ACTIONS;

/** The segment as a key of {@link SESSION_ACTIONS}, or `undefined` if it is none. */
function sessionActionSegment(value: string): SessionActionSegment | undefined {
  return (Object.keys(SESSION_ACTIONS) as readonly SessionActionSegment[])
    .find((segment) => segment === value);
}

/**
 * Exported so `local-control-isolation.test.ts` can assert the property that
 * matters rather than the spelling of the two vocabularies: every code the two
 * surfaces share must carry the same status and the same recoverable flag, so a
 * transport may map either straight through.
 */
export const STATUS_BY_CODE: Readonly<Record<LocalControlErrorCode, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  duplicate_request: 409,
  session_not_live: 409,
  rate_limited: 429,
  internal_error: 500,
});

/** Whether repeating the same request could plausibly succeed. */
export const RECOVERABLE_BY_CODE: Readonly<Record<LocalControlErrorCode, boolean>> = Object.freeze({
  unauthenticated: true,
  forbidden: false,
  invalid_request: true,
  not_found: false,
  conflict: true,
  duplicate_request: false,
  session_not_live: true,
  rate_limited: true,
  internal_error: true,
});

function responseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

export function okResponse(
  status: number,
  body: Readonly<Record<string, unknown>>,
): LocalControlResponse {
  return { status, headers: responseHeaders(), body };
}

export function errorResponse(
  code: LocalControlErrorCode,
  message: string,
  correlationId: string,
): LocalControlResponse {
  return {
    status: STATUS_BY_CODE[code],
    headers: responseHeaders(),
    body: {
      error: {
        code,
        message,
        correlationId,
        recoverable: RECOVERABLE_BY_CODE[code],
      },
    },
  };
}

export function jsonObject(request: LocalControlRequest): Record<string, unknown> {
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new LocalControlError("invalid_request", "Content-Type must be application/json");
  }
  if (request.body === undefined) {
    throw new LocalControlError("invalid_request", "JSON request body is required");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(request.body);
  } catch {
    throw new LocalControlError("invalid_request", "Request body must be valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LocalControlError("invalid_request", "Request body must contain valid JSON");
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new LocalControlError("invalid_request", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LocalControlError("invalid_request", "Request contains missing or unsupported fields");
  }
}

export function stringField(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new LocalControlError("invalid_request", `Field ${field} is invalid`);
  }
  return value;
}

export function uuidField(value: unknown, field: string): string {
  const text = stringField(value, field, 64);
  if (!UUID_PATTERN.test(text)) {
    throw new LocalControlError("invalid_request", `Field ${field} must be a UUID`);
  }
  return text;
}

export function commitField(value: unknown, field: string): string {
  const text = stringField(value, field, 64);
  if (!COMMIT_OID.test(text)) {
    throw new LocalControlError("invalid_request", `Field ${field} must be a full commit id`);
  }
  return text;
}

export function integerField(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new LocalControlError("invalid_request", `Field ${field} is invalid`);
  }
  return value as number;
}

/** The local channel proves the OS owner; the actor type records that fact. */
export const LOCAL_OWNER: LocalControlActor = Object.freeze({ isLocalOsOwner: true });

/**
 * Which local operation a request target names, or `undefined` when it names
 * none. Anything malformed answers `undefined`; the refusal itself is still
 * decided later, after admission, so an unauthenticated caller cannot tell a
 * malformed path from an unknown one.
 */
export function targetOf(request: LocalControlRequest): LocalRouteTarget | undefined {
  if (request.method.toUpperCase() !== "POST") return undefined;
  if (!request.path.startsWith("/") || request.path.startsWith("//")) return undefined;
  let url: URL;
  try {
    url = new URL(request.path, "http://local.invalid");
  } catch {
    return undefined;
  }
  if (url.search !== "") return undefined;
  const match = LOCAL_ROUTE.exec(url.pathname);
  if (!match) return undefined;
  const [, pairing, sessionParameter, sessionAction, deviceParameter] = match;
  if (pairing) {
    return Object.freeze({ action: "local.pairing.challenge", kind: "pairing-challenges" as const });
  }
  if (sessionParameter && sessionAction) {
    const kind = sessionActionSegment(sessionAction);
    if (!kind) return undefined;
    return Object.freeze({
      action: SESSION_ACTIONS[kind],
      kind,
      parameter: sessionParameter,
    });
  }
  if (deviceParameter) {
    return Object.freeze({
      action: "local.device.revoke" as const,
      kind: "revoke" as const,
      parameter: deviceParameter,
    });
  }
  return undefined;
}
