// Preserved-work review use-case (task 063-a): ant materializuoto `refs/verqestra/preserved/<sha>`
// paleidžia task'o `## Patikra` komandas ir įvertina, ar pakeisti keliai telpa į `## Failai`
// allowlist. Grąžina verdiktą, ne veiksmą — verify-task sprendimo šaka (063-b) juo tik pasinaudos.
//
// Materializavimas ir komandų paleidimas ateina per `PreservedWorkReviewPorts`: šis failas
// niekada nekviečia `node:child_process` ar git tiesiogiai.
import { allowedPaths, matchesAllowedPath } from "../../domain/tasks/allowed-paths.js";
import { parseBacktickChecks } from "../quality-gates/preflight-rules.js";
import { tailChars } from "./task-events-model.js";
import type {
  PreservedWorkCheckResult,
  PreservedWorkReviewParams,
  PreservedWorkReviewPorts,
  PreservedWorkReviewVerdict,
} from "./preserved-work-review-model.js";

/**
 * `recovered` TIK kai VISOS `## Patikra` komandos grąžina exit 0 IR visi preserved diff'o
 * keliai telpa į `## Failai` allowlist; kitu atveju `needs-human` su patikrų uodega ir
 * preserved ref nuoroda, kad operatorius žinotų, kur ieškoti neatkurto darbo.
 */
export async function reviewPreservedWork(
  params: PreservedWorkReviewParams,
  ports: PreservedWorkReviewPorts,
): Promise<PreservedWorkReviewVerdict> {
  const materialized = await ports.materialize(params.ref);
  if (!materialized.ok) {
    return {
      verdict: "needs-human",
      ref: params.ref,
      reason: `preserved_work_materialize_failed=${materialized.reason} ref=${params.ref}`,
      checks: [],
    };
  }

  const { work } = materialized;
  try {
    const checks: PreservedWorkCheckResult[] = [];
    for (const command of parseBacktickChecks(params.taskMarkdown)) {
      const result = await ports.runCheck(work.worktreePath, command);
      checks.push({ command, exitCode: result.exitCode, output: result.output });
    }

    const failedChecks = checks.filter((check) => check.exitCode !== 0);
    const allowed = allowedPaths(params.taskMarkdown);
    const outsideAllowlist = work.changedPaths.filter(
      (file) => !allowed.some((pattern) => matchesAllowedPath(file, pattern)),
    );

    if (failedChecks.length === 0 && allowed.length > 0 && outsideAllowlist.length === 0) {
      return { verdict: "recovered", ref: params.ref, changedPaths: work.changedPaths, checks };
    }

    return {
      verdict: "needs-human",
      ref: params.ref,
      reason: buildNeedsHumanReason(params.ref, failedChecks, outsideAllowlist),
      checks,
    };
  } finally {
    // Dispose'o nesėkmė (fail-closed, infra kontraktas) sąmoningai užgožia jau apskaičiuotą
    // verdiktą — worktree, kurio nepavyko pašalinti, yra infrastruktūros incidentas, ne
    // peržiūros rezultatas.
    await work.dispose();
  }
}

function buildNeedsHumanReason(ref: string, failedChecks: PreservedWorkCheckResult[], outsideAllowlist: string[]): string {
  const parts = [`preserved_work_review ref=${ref}`];
  if (failedChecks.length > 0) {
    parts.push(`checks_failed=${failedChecks.length}`);
    for (const check of failedChecks) {
      parts.push(`[${check.command}] exit=${check.exitCode} ${tailChars(check.output)}`);
    }
  }
  if (outsideAllowlist.length > 0) {
    parts.push(`paths_outside_allowlist=${outsideAllowlist.join(",")}`);
  }
  return parts.join(" ");
}
