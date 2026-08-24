import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GateResult,
  SessionGateEvidence,
  SessionGateEvidencePort,
  SessionGateEvidenceWritePort,
} from "../application/ports/session-gate-evidence-port.js";

/**
 * Recorded gate outcomes, one file per session.
 *
 * Every failure — a missing file, malformed JSON, a record that does not match
 * its own file name — resolves to `undefined`, which the integration flow reads
 * as "gates did not pass". That is the only safe direction: evidence the
 * gateway cannot parse is evidence it cannot rely on, and the alternative would
 * be merging on the strength of a file nobody validated.
 *
 * The session id is matched against the UUID form before it becomes part of a
 * path, so a caller can never reach outside the evidence directory.
 *
 * Reading and writing are separate factories rather than one object with two
 * methods. The integration flow verifies evidence and must not be able to
 * author it, so a composition root hands the reader to the verifier and the
 * recorder to the gate run — two capabilities, two holders.
 *
 * NUKRYPIMAS (formos, ne elgesio): prieiga prie neparsinto įrašo laukų eina per bracket, o ne
 * per tašką. `noPropertyAccessFromIndexSignature` taško prieigos prie `Record<string, unknown>`
 * neleidžia, ir tai teisinga — nė vienas iš šių laukų dar nėra įrodytas egzistuojančiu.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_OID = /^[0-9a-f]{40}$/;
const MAX_GATES = 64;
const MAX_GATE_NAME_LENGTH = 120;
/**
 * The largest file this reader will pull into memory.
 *
 * A record the writer can produce is bounded by {@link MAX_GATES} and
 * {@link MAX_GATE_NAME_LENGTH} to a few kilobytes, so this ceiling refuses only
 * files the gateway did not write — and the gate run now executes the
 * repository's own build and test commands under the operator's account, which
 * is exactly the situation in which "a file in a host directory" stops being
 * self-evidently the gateway's own. Reading an arbitrarily large one would turn
 * a preview into a memory exhaustion.
 */
const MAX_EVIDENCE_BYTES = 64 * 1024;
const GATE_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "timed_out", "errored"]);

function isGateStatus(value: unknown): value is NonNullable<GateResult["status"]> {
  return typeof value === "string" && GATE_STATUSES.has(value);
}

function gateResults(value: unknown): readonly GateResult[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_GATES) {
    return undefined;
  }
  const gates: GateResult[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") {
      return undefined;
    }
    const gate = entry as Record<string, unknown>;
    const name = gate["name"];
    const passed = gate["passed"];
    const status = gate["status"];
    const durationMs = gate["durationMs"];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_GATE_NAME_LENGTH ||
      typeof passed !== "boolean"
    ) {
      return undefined;
    }
    // One name, one result. A file naming a gate twice cannot be read as a
    // verdict about that gate, and a reader that picked either entry would be
    // choosing the answer for the operator.
    if (names.has(name)) {
      return undefined;
    }
    names.add(name);
    // The diagnostics are optional, but a malformed one is still a malformed
    // record: a file this reader half-understands is not evidence.
    if (status !== undefined && !isGateStatus(status)) {
      return undefined;
    }
    if (
      durationMs !== undefined &&
      (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)
    ) {
      return undefined;
    }
    gates.push(Object.freeze({
      name,
      passed,
      ...(status === undefined ? {} : { status: status as NonNullable<GateResult["status"]> }),
      ...(durationMs === undefined ? {} : { durationMs: durationMs as number }),
    }));
  }
  return Object.freeze(gates);
}

/**
 * The record's text, or `undefined` when it is not a regular file of a size the
 * writer could have produced. Size and content are read through ONE handle, so
 * the file that is measured is the file that is read.
 */
async function boundedText(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_EVIDENCE_BYTES) {
      return undefined;
    }
    return await handle.readFile("utf8");
  } finally {
    // A close that fails must not turn a record this reader already has into
    // "no evidence"; the handle is released either way when the process exits.
    await handle.close().catch(() => undefined);
  }
}

export function createFileSessionGateEvidenceStore(directory: string): SessionGateEvidencePort {
  return {
    async evidenceFor(sessionId: string): Promise<SessionGateEvidence | undefined> {
      if (!UUID_PATTERN.test(sessionId)) {
        return undefined;
      }
      let parsed: unknown;
      try {
        const text = await boundedText(join(directory, `${sessionId}.json`));
        if (text === undefined) {
          return undefined;
        }
        parsed = JSON.parse(text);
      } catch {
        return undefined;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      const record = parsed as Record<string, unknown>;
      const gates = gateResults(record["gates"]);
      const commit = record["commit"];
      const recordedAt = record["recordedAt"];
      if (
        record["sessionId"] !== sessionId ||
        typeof commit !== "string" ||
        !COMMIT_OID.test(commit) ||
        typeof recordedAt !== "string" ||
        !Number.isFinite(Date.parse(recordedAt)) ||
        gates === undefined
      ) {
        return undefined;
      }
      return Object.freeze({
        sessionId,
        commit,
        gates,
        recordedAt,
      });
    },
  };
}

/**
 * The writer applies exactly the reader's rules before anything reaches the
 * disk. A record the reader would reject is not a record at all: it would be
 * returned as `undefined`, the integration flow would report "no gates", and a
 * green run would have been lost silently instead of loudly.
 */
function assertRecordable(evidence: SessionGateEvidence): void {
  if (!UUID_PATTERN.test(evidence.sessionId)) {
    throw new Error("Gate evidence names an unusable session id");
  }
  if (!COMMIT_OID.test(evidence.commit)) {
    throw new Error("Gate evidence names an unusable commit");
  }
  if (!Number.isFinite(Date.parse(evidence.recordedAt))) {
    throw new Error("Gate evidence names an unusable instant");
  }
  if (gateResults(evidence.gates) === undefined) {
    throw new Error("Gate evidence describes an unusable gate list");
  }
}

export function createFileSessionGateEvidenceRecorder(directory: string): SessionGateEvidenceWritePort {
  return {
    async record(evidence: SessionGateEvidence): Promise<void> {
      assertRecordable(evidence);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // A unique temporary name with `wx` means two concurrent recorders never
      // share a partial file, and the rename that follows is what makes a reader
      // see either the previous record or the complete new one.
      const temporary = join(directory, `${evidence.sessionId}.${randomUUID()}.tmp`);
      const target = join(directory, `${evidence.sessionId}.json`);
      try {
        await writeFile(temporary, JSON.stringify(evidence), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        // The cleanup is best effort on purpose: a temporary file that cannot be
        // removed is a leftover, while the write failure is the fact the caller
        // has to act on. Letting `rm` throw here would replace the real cause
        // with the tidying that failed after it.
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new Error(`Gate evidence could not be written: ${(error as Error).message}`);
      }
    },
  };
}
