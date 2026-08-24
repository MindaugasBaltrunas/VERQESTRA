/**
 * Read-only push notification boundary to the operator's already-paired
 * device. `design.md` §10 makes "mobile cannot drive AG Loop" a property of
 * every AG Loop-facing contract; this port is the write side of that same
 * boundary for notifications, so it must be unable to carry anything a
 * malicious or buggy caller could turn into a leak.
 *
 * The payload shape is a closed record of an enumerated event type, an
 * enumerated source, an opaque identifier and a timestamp. There is no
 * free-form message, title, body or detail field, so there is nowhere to put
 * a credential, a host path or terminal output — the same design the audit
 * log (`audit-port.ts`) already uses for the same reason.
 *
 * The type alone is not enough: a caller can still build an object that
 * type-checks with a `subjectId` that IS a leaked path or token, because
 * `subjectId` is a `string`. {@link createPushNotificationPayload} is the
 * runtime half of the contract — it rejects anything that does not look like
 * an opaque identifier instead of trusting the caller's convention.
 */

export type PushNotificationEventType = "failed" | "completed";
export type PushNotificationSource = "ag-loop-read" | "mobile-terminal";

export type PushNotificationPayload = Readonly<{
  type: PushNotificationEventType;
  source: PushNotificationSource;
  /** Opaque AG Loop task id or mobile terminal session id — never a path, never content. */
  subjectId: string;
  /** ISO-8601 UTC instant. */
  occurredAt: string;
}>;

export class PushNotificationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushNotificationPayloadError";
  }
}

const EVENT_TYPES: ReadonlySet<string> = new Set<PushNotificationEventType>(["failed", "completed"]);
const SOURCES: ReadonlySet<string> = new Set<PushNotificationSource>(["ag-loop-read", "mobile-terminal"]);

const SUBJECT_ID_MAX_LENGTH = 128;

/**
 * Whitelist, not a blacklist: only letters, digits, `.`, `_` and `-`. This
 * alone rejects every path shape this codebase redacts elsewhere
 * (`ag-loop-read-redaction.ts`'s `PATH_PATTERNS`) — `/`, `\`, `~` and `:` are
 * all outside the class — and rejects terminal output text, which carries
 * spaces, newlines and punctuation no opaque identifier needs.
 */
const SUBJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** `..` is a path-traversal segment even inside an otherwise-whitelisted string. */
const PATH_TRAVERSAL = /\.\./;

/**
 * Token shapes that happen to fit the identifier whitelist above, so the
 * charset check alone would let them through. Mirrors the provider-prefix and
 * compact-JWS patterns in `ag-loop-read-redaction.ts`'s `SECRET_PATTERNS`,
 * because an opaque id and a credential can otherwise look identical once
 * spaces and separators are removed.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /^(?:gh[pousr]_|github_pat_|sk-|npm_|hf_)[A-Za-z0-9_-]{8,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
];

function isOpaqueSubjectId(value: string): boolean {
  if (!SUBJECT_ID_SHAPE.test(value) || value.length > SUBJECT_ID_MAX_LENGTH) return false;
  if (PATH_TRAVERSAL.test(value)) return false;
  if (TOKEN_SHAPES.some((pattern) => pattern.test(value))) return false;
  return true;
}

/**
 * Builds a {@link PushNotificationPayload}, rejecting anything outside the
 * closed contract instead of coercing or truncating it. A push notification
 * is fire-and-forget by nature — there is no caller left to hand a partial or
 * best-effort payload back to, so the only safe failure mode is to not send.
 */
export function createPushNotificationPayload(input: {
  type: PushNotificationEventType;
  source: PushNotificationSource;
  subjectId: string;
  occurredAt: string;
}): PushNotificationPayload {
  if (!EVENT_TYPES.has(input.type)) {
    throw new PushNotificationPayloadError(`Invalid push notification type: ${String(input.type)}`);
  }
  if (!SOURCES.has(input.source)) {
    throw new PushNotificationPayloadError(`Invalid push notification source: ${String(input.source)}`);
  }
  if (typeof input.subjectId !== "string" || !isOpaqueSubjectId(input.subjectId)) {
    throw new PushNotificationPayloadError("Push notification subjectId is not an opaque identifier");
  }
  if (typeof input.occurredAt !== "string" || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new PushNotificationPayloadError("Push notification occurredAt is not a valid timestamp");
  }
  return Object.freeze({
    type: input.type,
    source: input.source,
    subjectId: input.subjectId,
    occurredAt: input.occurredAt,
  });
}

export interface PushNotificationPort {
  send(payload: PushNotificationPayload): Promise<void>;
}
