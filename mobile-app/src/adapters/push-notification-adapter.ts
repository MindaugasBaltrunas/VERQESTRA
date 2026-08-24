import type {
  PushNotificationEventType,
  PushNotificationPayload,
  PushNotificationSource,
} from "../model/ports.js";
import { exactKeys, isRecord } from "./shared/gateway-format.js";

/**
 * Turns whatever the OS delivered into a notification the operator may see.
 *
 * The adapter is the only place a push payload is trusted, so it is written as
 * a filter rather than as a parser with a fallback: a delivery that is not
 * exactly the mirrored contract is dropped whole, never partially rendered.
 * Nothing user-visible is taken from the payload except the subject id, and
 * only after that id has been proven opaque — a notification must not be able
 * to carry a repository path, terminal output or a credential onto the lock
 * screen of a device that is not even unlocked.
 *
 * SKAIDYMAS (MVA → MVC): etalone šiame faile gyveno ir parseris, ir projekcija
 * (`presentPushNotification`), ir pats pluoštas (`PushNotificationInbox`) — 245 eilutės.
 * Parseris yra pasitikėjimo riba, tad lieka adapteryje; projekcija ir pluoštas — tai, ką MVC
 * vadina kontroleriu, ir jie perkelti į `controller/presentation/push-notification-presenter.ts`.
 * Rodyklė nuo to nepasikeitė: kontroleris importuoja adapterį, ne atvirkščiai.
 */

/** The complete payload surface; an extra field makes it a different document. */
const payloadKeys: readonly string[] = Object.freeze([
  "type",
  "source",
  "subjectId",
  "occurredAt",
]);

/**
 * Written as records rather than arrays so the type checker fails on a union
 * member that is added to the contract but forgotten here.
 */
const eventTypes: Readonly<Record<PushNotificationEventType, true>> = Object.freeze({
  failed: true,
  completed: true,
});

const sources: Readonly<Record<PushNotificationSource, true>> = Object.freeze({
  "ag-loop-read": true,
  "mobile-terminal": true,
});

/**
 * An opaque id: letters, digits and the three separators the gateway's own ids
 * use. It admits no path separator, no whitespace, no control or escape byte,
 * and is bounded at 128 characters, so a subject id can never become a line of
 * terminal output or a file path in disguise.
 */
const SUBJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** `a..b` is still a traversal attempt even where no separator survived the shape. */
const PATH_TRAVERSAL = /\.\./;

/**
 * Secret shapes that would otherwise pass as an opaque id. This is a refusal to
 * display, not a detector: a token reaching the notification tray is a leak on
 * a locked device, so a recognisable one drops the whole delivery rather than
 * being masked and shown.
 */
const TOKEN_SHAPES: readonly RegExp[] = Object.freeze([
  /^(?:gh[pousr]_|github_pat_|sk-|npm_|hf_)[A-Za-z0-9_-]{8,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
]);

/**
 * An ISO-8601 instant with an explicit offset. Time of day and offset are
 * bounded by the shape itself; the date is only captured, because no regex can
 * decide whether a day exists in its month.
 */
const OCCURRED_AT_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

const monthLengths: readonly number[] = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/**
 * NUKRYPIMAS (forma, ne elgesys): `noUncheckedIndexedAccess` daro `monthLengths[month - 1]`
 * `number | undefined`. Kryptis pasirinkta fail-closed — mėnuo už 1..12 ribų gauna 0, tad
 * `day > daysInMonth(...)` tokį pristatymą ATMES. Praktiškai to niekada neįvyksta: vienintelis
 * kviečiantysis pirma patikrina ribas, o `??` čia yra tos invarianto vietos įvardijimas.
 */
function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2) return leap ? 29 : 28;
  return monthLengths[month - 1] ?? 0;
}

function isEventType(value: unknown): value is PushNotificationEventType {
  return typeof value === "string" && Object.hasOwn(eventTypes, value);
}

function isSource(value: unknown): value is PushNotificationSource {
  return typeof value === "string" && Object.hasOwn(sources, value);
}

function isOpaqueSubjectId(value: unknown): value is string {
  return typeof value === "string" &&
    SUBJECT_ID_SHAPE.test(value) &&
    !PATH_TRAVERSAL.test(value) &&
    !TOKEN_SHAPES.some((shape) => shape.test(value));
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = OCCURRED_AT_SHAPE.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText] = match;
  // The three groups are not optional in the shape, so this cannot happen; it is
  // written out rather than asserted because a refusal is the right answer to
  // "the shape matched but produced nothing", whatever made that true.
  if (yearText === undefined || monthText === undefined || dayText === undefined) return false;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  // A day that does not exist has to be refused here: the engine's parser
  // silently rolls `2026-02-30` over into March, which would date a
  // notification two days after the event it reports.
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * `null`, never a throw: a rejected push has no caller to report to. It arrives
 * on a platform callback, and an exception there would surface as a crash of
 * the shell rather than as a notification that was quietly not shown.
 */
export function parsePushNotification(delivered: unknown): PushNotificationPayload | null {
  try {
    if (!isRecord(delivered) || !exactKeys(delivered, payloadKeys)) return null;
    // Each field is read exactly once, into a local the checks and the result
    // below both use, so a property that answers differently on a second read
    // cannot be validated as one value and displayed as another.
    const type = delivered["type"];
    const source = delivered["source"];
    const subjectId = delivered["subjectId"];
    const occurredAt = delivered["occurredAt"];
    if (!isEventType(type) || !isSource(source)) return null;
    if (!isOpaqueSubjectId(subjectId) || !isInstant(occurredAt)) return null;
    return Object.freeze({ type, source, subjectId, occurredAt });
  } catch {
    // "Never a throw" has to cover the delivery itself, not only the rules:
    // enumerating or reading whatever the platform handed over can fail on its
    // own — a lazy own getter, or a proxy that refuses to be inspected. Such a
    // delivery is one that could not be proven safe, which is the same answer
    // as one that failed a check, and it must not surface as a crash of the
    // shell from inside the OS callback.
    return null;
  }
}
