// Pure task-dependency rules: what a task's `## Dependencies` section means and how a
// blocked-task notice is rendered. FS persistence lives in later layers.
// Behaviour etalon: AG_loop domain/tasks/dependencies.ts. WBR VQ-201 changes: markdown
// section reader comes straight from shared/markdown (no compat shim), the ledger key is
// the unified identity.taskLedgerKey, and DEPENDENCY_PLACEHOLDERS is exported so the
// scheduler consumes the same set instead of keeping a copy (AG_loop R8).

import { taskLedgerKey } from "./identity.js";
import { extractSection } from "../../shared/markdown.js";

export type TaskDependencyMetadata = {
  task_id: string;
  file: string;
  blocked_by: string[];
};

export type BlockedTaskRoute = {
  task_id: string;
  from: string;
  to: string;
  blocked_by: string;
};

/**
 * Placeholder texts that are NOT a real dependency (PDAG-2). Templates write `none` / `-`
 * / `TBD` under `## Dependencies` to mean "no blockers"; read as a task id such a value
 * would block the whole queue behind a task that can never exist. Values are compared
 * AFTER {@link normalizeTaskReference} (hence `n-a`). Exported: every consumer of
 * caller-supplied `blocked_by` arrays must filter with THIS set, never a private copy.
 */
export const DEPENDENCY_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "none",
  "no",
  "n-a",
  "na",
  "nera",
  "n-ra",
  "tbd",
  "null",
  "-",
]);

/** True when a normalized dependency reference is a "no dependencies" placeholder (PDAG-2). */
export function isPlaceholderDependency(reference: string): boolean {
  return DEPENDENCY_PLACEHOLDERS.has(reference.trim().toLowerCase());
}

/**
 * Reads a task's `## Dependencies` section into its normalized blocker set. PDAG-2 is
 * enforced here, at the parse boundary: placeholder values never leave this function as
 * dependencies, so no downstream consumer has to re-learn that rule.
 */
export function parseTaskDependencies(taskText: string, taskFile = "task.md"): TaskDependencyMetadata {
  const taskId = taskLedgerKey(taskFile);
  const dependenciesText =
    extractSection(taskText, "## Dependencies") ||
    extractSection(taskText, "## Priklausomybės") ||
    extractSection(taskText, "## Priklausomybes");
  const blockedBy = new Set<string>();

  for (const line of dependenciesText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const keyValue = trimmed.match(
      /^(?:[-*]\s*)?(?:blocked_by|blocked-by|depends_on|depends-on|priklauso_nuo|priklauso-nuo)\s*:\s*(.+)$/i,
    );
    if (keyValue?.[1]) {
      for (const value of splitDependencyValues(keyValue[1])) blockedBy.add(normalizeTaskReference(value));
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) blockedBy.add(normalizeTaskReference(bullet[1]));
  }

  const inlineMatches = taskText.matchAll(/(?:blocked_by|blocked-by|depends_on|depends-on)\s*:\s*([^\n]+)/gi);
  for (const match of inlineMatches) {
    for (const value of splitDependencyValues(match[1] ?? "")) blockedBy.add(normalizeTaskReference(value));
  }

  return {
    task_id: taskId,
    file: taskFile.replace(/\\/g, "/"),
    blocked_by: Array.from(blockedBy)
      .filter((value) => value && !isPlaceholderDependency(value))
      .sort(),
  };
}

/**
 * Ar NUORODA gali reikšti šį task'ą.
 *
 * SIMETRIŠKAS prefiksas čia sąmoningas: task failai blokatorių rašo tai sutrumpintai
 * (`depends_on: 0042`), tai pilnu vardu, o mazgo ID gali būti bet kuris iš jų.
 *
 * NAUDOTI TIK REZOLIUCIJAI — „kurį task'ą turėjo omenyje ši nuoroda". TAPATYBIŲ palyginimui
 * skirtas {@link isSameTask}: prefiksas ten reikštų, kad tėvas „yra" savo vaikas, ir būtent taip
 * 2026-08-23 buvo prarandami vaikiniai task'ai (žr. `isSameTask` doc'ą).
 */
export function dependencyMatches(dependency: string, blocker: string): boolean {
  return dependency === blocker || dependency.startsWith(`${blocker}-`) || blocker.startsWith(`${dependency}-`);
}

/**
 * Ar tai TAS PATS task'as. Tikslus palyginimas po normalizacijos.
 *
 * 2026-08-23 (operatoriaus radiniai, P1): `dependencyMatches` buvo taikomas ir TAPATYBĖMS —
 * užbaigtų bei lūžusių task'ų rinkiniams, resume checkpoint'ui ir savęs nuorodos aptikimui. Kadangi
 * jis simetriškas, `0042-parent` ir `0042-parent-02-child` atrodė kaip tas pats task'as:
 *
 *   užbaigus `0042-parent` vaikas TYLIAI dingdavo iš bangos (kanoninis ready-set jį leido, o
 *   bangos planas grąžindavo `ready=[] blocked=[]`; vartai SUBTRACT-ONLY, tad grąžinti jo nebegali,
 *   ir `nextTask()` skelbdavo eilę tuščia);
 *   resume checkpoint'as vaikui grąžindavo `skip-completed / already-completed`, o atkūrimas
 *   galėjo perkelti jo failą į `done` jo NEVYKDĘS;
 *   normalizavimas `0042-parent` laikydavo vaiko SAVĘS nuoroda ir tą briauną nuimdavo, tad vaikas
 *   nepatekdavo į lūžusią šaką, o grafo hash'as tos briaunos nematydavo.
 *
 * Tapatybė neturi prefiksų. Sutrumpinta nuoroda išsprendžiama ATSKIRAI ir vienareikšmiškai.
 */
export function isSameTask(left: string, right: string): boolean {
  const normalizedLeft = normalizeTaskReference(left);
  return normalizedLeft !== "" && normalizedLeft === normalizeTaskReference(right);
}

/**
 * Nuoroda → konkretus task ID iš ŽINOMŲ ID visatos. Ta pati taisyklė kaip kanoninio grafo
 * `resolveTaskNode`: tikslus atitikmuo laimi, kitaip vienintelis prefiksinis kandidatas, o
 * dviprasmybė grąžina „nežinau" (`undefined`), o ne pirmą pagal rūšiavimą.
 *
 * Skirtas tiems kvietėjams, kurie turi ne `TaskGraph`, o tik ID sąrašą. Be jo tie kvietėjai
 * lygindavo nuorodą su KIEKVIENU rinkinio nariu simetriškai, ir `0042-parent` „atitikdavo"
 * `0042-parent-02-child`: task'as, priklausantis nuo tėvo, būdavo maršrutizuojamas į
 * human-review pranešus apie vaiką, o į lūžusią šaką patekdavo nesusiję task'ai.
 */
export function resolveTaskReference(universe: readonly string[], reference: string): string | undefined {
  const normalized = normalizeTaskReference(reference);
  if (!normalized) return undefined;
  if (universe.includes(normalized)) return normalized;
  const candidates = universe.filter((id) => dependencyMatches(normalized, id));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function normalizeTaskReference(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^AG\/tasks\/[A-Za-z-]+\//, "")
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function splitDependencyValues(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function withBlockedNotice(taskText: string, blocker: string): string {
  if (/## Human review block\b/.test(taskText)) return taskText;
  const notice = `\n## Human review block\n- blocked_by: ${blocker}\n- reason: upstream task entered human-review or failed routing. Review dependency before requeue.\n`;
  return `${taskText.trimEnd()}\n${notice}`;
}
