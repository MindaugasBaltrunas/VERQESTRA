// Code-index šviežumo vartai graph-aware ir existing-code taskams. Behaviour etalon:
// AG_loop code-index/guard.ts; FS — per portą (WBR VQ-301). Klaidos tekste komandos vardas
// pakeistas iš `ag code-index build` į engine-neutralų — CLI forma prisistato E5.

import path from "node:path";
import { extractSection } from "../../../shared/markdown.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { buildCodeIndex } from "../indexing/builder.js";
import { checkCodeIndexFreshness } from "../store/code-index-store.js";

export async function assertFreshCodeIndexForGraphAwareTask(
  fs: CodeIntelligenceFileSystemPort,
  taskFileArg: string | undefined,
  projectRoot: string,
): Promise<void> {
  if (!taskFileArg) {
    return;
  }

  const taskPath = path.isAbsolute(taskFileArg) ? taskFileArg : path.resolve(projectRoot, taskFileArg);
  const taskText = await fs.readTextFile(taskPath);
  if (!requiresFreshCodeIndex(taskText)) {
    return;
  }

  const freshness = await checkCodeIndexFreshness(fs, projectRoot);
  if (!freshness.ok) {
    throw new Error(
      `code graph task requires a fresh code index before dispatch: ${freshness.reason}. Run the code-index build command.`,
    );
  }
}

const GRAPH_CONTEXT_REQUEST = /--with-code-graph|code graph context|code graph kontekst|code intelligence/i;
const INDEX_BUILD_ACTION = /code-index storage|code-index build|Build code-index/i;

/**
 * Ar task'ui prieš dispatch'ą reikia ŠVIEŽIO code index.
 *
 * VIENA vieta (2026-08-24, RAG auditas 5). Iki tol ta pati taisyklė buvo užrašyta DU kartus — čia
 * ir `quality-gates/preflight` — ir kopijos jau buvo IŠSISKYRUSIOS: preflight nepažino nei
 * `code intelligence` (tad task'ą, kurį šis vartas dispatch'o metu blokuoja, jis praleisdavo kaip
 * galiojantį), nei `Build code-index` (tad task'ui, kurio DARBAS yra pastatyti indeksą, jis
 * priekaištaudavo, kad indeksas nešviežias). Vieno varto dvi taisyklės nesutampa tyliai, kol
 * kas nors nepaklausia, kuri iš jų teisinga.
 *
 * Carve-out'as (`buildsIndex`) skaitomas iš teksto BE `## Neįtraukta` sekcijos. Ta sekcija yra
 * aiškus NE-tikslas: ten paminėta frazė reiškia „šito NEDAROME", o skaitant ją kartu su visu tekstu
 * eilutė `- code-index build (jį daro kitas task'as)` IŠJUNGDAVO vartą būtent tam task'ui, kuris
 * indekso nestato — fail-open per neigimą.
 */
export function requiresFreshCodeIndex(taskText: string): boolean {
  if (!GRAPH_CONTEXT_REQUEST.test(taskText)) {
    return false;
  }
  const outOfScope = extractSection(taskText, "## Neįtraukta");
  const claimedWork = outOfScope.length > 0 ? taskText.replace(outOfScope, "") : taskText;
  return !INDEX_BUILD_ACTION.test(claimedWork);
}

/**
 * Outcome of `ensureFreshCodeIndexForExistingCodeTask`: `skip` when the task has no
 * existing-file targets (new-file work never needs a code index); `fresh`/`rebuilt`
 * once the index is confirmed usable (rebuilt = it was stale/missing and the
 * deterministic builder just repaired it); `blocked` only when the rebuild itself
 * failed or still could not produce a fresh index.
 */
export type CodeIndexReadiness =
  | { kind: "skip" }
  | { kind: "fresh"; existingTargets: string[] }
  | { kind: "rebuilt"; existingTargets: string[] }
  | { kind: "blocked"; reason: string };

export async function filterExistingTargets(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  targets: string[],
): Promise<string[]> {
  const checks = await Promise.all(targets.map((target) => fs.exists(path.join(projectRoot, target))));
  return targets.filter((_target, index) => checks[index]);
}

/**
 * Existing-code tasks (at least one `## Failai` target that already exists on disk)
 * must never silently lose code graph context because the index is stale or missing.
 * This first tries a deterministic rebuild — the same builder the CLI build command
 * runs — and only reports `blocked` when the rebuild itself throws or still fails to
 * produce a fresh index; new-file tasks (`skip`, no existing targets) never require
 * an index at all.
 */
export async function ensureFreshCodeIndexForExistingCodeTask(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  allowedTargets: string[],
): Promise<CodeIndexReadiness> {
  const existingTargets = await filterExistingTargets(fs, projectRoot, allowedTargets);
  if (existingTargets.length === 0) {
    return { kind: "skip" };
  }

  const freshness = await checkCodeIndexFreshness(fs, projectRoot);
  if (freshness.ok) {
    return { kind: "fresh", existingTargets };
  }

  try {
    await buildCodeIndex(fs, projectRoot);
  } catch (error) {
    return {
      kind: "blocked",
      reason: `code index is not fresh (${freshness.reason}) and the deterministic rebuild failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const rebuilt = await checkCodeIndexFreshness(fs, projectRoot);
  if (!rebuilt.ok) {
    return { kind: "blocked", reason: `code index rebuild did not produce a fresh index: ${rebuilt.reason}` };
  }
  return { kind: "rebuilt", existingTargets };
}
