// Diagnozės įrodymų surinkimas (etalono claude-diagnose evidencijos blokas): log uodegos,
// stream-json triukšmo filtras (task 0024), session-writes nuosavybės atributacija
// (875/0018/0049) ir HEAD siaurinimas per pendingAttemptChangedFiles.

import {
  filterStagePathsByOwnership,
  pendingAttemptChangedFiles,
  resolveDispatchSessionNonce,
  sessionScopedChangedFiles,
} from "../../../../application/task-execution/index.js";
import type { ClaudeDiagnosePorts, StopEvidenceView } from "./diagnose-ports.js";

export function tailLines(content: string, maxLines: number): string {
  if (!content) return "";
  return content.split(/\r?\n/).slice(-maxLines).join("\n");
}

// Task 0024: stream-json sesijos log eilutė, prasidedanti `{`/`[`, yra žalias transcript
// ĮVYKIS (pvz. user įrašas, cituojantis įrankio išvestį), o ne runner'io plain-text
// įrodymas. Toks triukšmas evaluateLocalDiagnosis regex skene paverstų cituotą "TypeError"
// tikra lokalia klaida, o per-attempt `tool_use_id` nugalėtų repeated-error dedup'ą.
// Plain-text launcher klaidos niekada neprasideda `{`/`[` — jos praeina nepaliestos.
const STREAM_JSON_EVENT_LINE = /^\s*[[{]/;

export function stripStreamJsonTranscriptLines(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => !STREAM_JSON_EVENT_LINE.test(line))
    .join("\n");
}

export type SessionAttribution = {
  /** ŠIO bandymo pending pakeitimai out-of-scope patikrai. */
  sessionChangedFiles: string[];
  /** Žurnalo eilutės (foreign/settled/warning) — spausdina kvietėjas ta pačia tvarka. */
  logLines: string[];
};

/**
 * Out-of-scope atributacija remiasi ŠIOS sesijos rašymų ledger'iu, ne globaliu git status
 * (regresija 875); bendro ledger'io co-tenant rašymai išmetami per ownership sidecar'ą
 * (0018/0056), tapatybė atgaunama iš stop įrodymo fail-closed pagal kilmę (0049), o HEAD
 * atitinkantys keliai nusėda kaip settled (0049-3; langas nežinomas — rinkinys nekinta).
 */
export async function collectSessionAttribution(
  ports: ClaudeDiagnosePorts,
  input: {
    taskId: string;
    stopEvidence: StopEvidenceView;
    dirtyPaths: string[];
    windowBaseHead: string;
  },
): Promise<SessionAttribution> {
  const logLines: string[] = [];
  const { taskId, stopEvidence } = input;

  const ledger = await ports.readSessionWrites();
  const dispatchIdentity = {
    session: resolveDispatchSessionNonce({
      envNonce: ports.envDispatchNonce(),
      origin: stopEvidence.origin,
      recordNonce: typeof stopEvidence.record["dispatch_nonce"] === "string" ? stopEvidence.record["dispatch_nonce"] : "",
      recordTaskId: stopEvidence.taskId ?? "",
      taskId,
    }),
    taskId: (await ports.readCurrentTaskId()).trim(),
  };
  if (!dispatchIdentity.session && Object.keys(ledger.owners).length > 0) {
    logLines.push(`WARNING: dispatch identity unavailable task=${taskId} — ownership attribution skipped (HEAD narrowing only)`);
  }
  const ownedSessionWrites = filterStagePathsByOwnership(ledger.writes, ledger.owners, dispatchIdentity);
  for (const foreignPath of ownedSessionWrites.foreign) {
    logLines.push(`SESSION WRITES FOREIGN: task=${taskId} path=${foreignPath} — ignoring foreign dispatch write`);
  }

  const attribution = pendingAttemptChangedFiles({
    changedFiles: sessionScopedChangedFiles(ownedSessionWrites.paths),
    dirtyPaths: input.dirtyPaths,
    windowProductPaths: input.windowBaseHead ? await ports.git.changedProductPathsSince(input.windowBaseHead) : [],
    windowKnown: input.windowBaseHead.length > 0,
  });
  for (const settledPath of attribution.settled) {
    logLines.push(`SESSION WRITES SETTLED: task=${taskId} path=${settledPath} — matches HEAD, not a pending write`);
  }
  if (!ledger.present) {
    logLines.push(
      `WARNING: session-writes.json missing task=${taskId} — skipping out-of-scope attribution (safe fallback, no false human_review)`,
    );
  }

  return { sessionChangedFiles: attribution.pending, logLines };
}
