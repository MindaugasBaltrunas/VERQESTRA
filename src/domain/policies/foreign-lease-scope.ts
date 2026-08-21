// Runtime nuosavybės (worker lease) vartų APRĖPTIES klasifikacija (etalonas: AG_loop
// hooks/write-policy.ts classifyForeignLeaseGuardScope 1:1). Gryna: kelio egzistavimą,
// `realpath` išsprendimą ir gyvų lease'ų sąrašą paduoda kvietėjas.

import { collapseTraversal, escapesRoot } from "./write-policy.js";

/** Kodėl kelias pateko (arba nepateko) į runtime nuosavybės vartų carve-out'ą. */
export type ForeignLeaseGuardScopeReason =
  /** Absoliutus kelias už šio proceso darbo kopijos ribų (OS temp, memory katalogai). */
  | "outside-project-root"
  /** Kito — ne gyvo lease'o — worktree kopija: atskiras checkout'as, kurio niekas nerašo. */
  | "foreign-worktree"
  /** Dar neegzistuojantis failas po `AG/tasks/queue/**` — eilės papildymas. */
  | "new-queue-file"
  /** Gyvo (`held`) lease'o worktree: ten dirba kitas rašytojas — carve-out netaikomas. */
  | "live-worktree"
  /** Esamas `AG/tasks/queue/**` failas: redagavimas/trynimas lieka saugomas. */
  | "existing-queue-file"
  /** `..` išeina už starto katalogo — fail-closed, carve-out netaikomas. */
  | "escapes-root"
  /** Šio medžio produkto kelias — fencing galioja nepakitęs. */
  | "product-tree";

export type ForeignLeaseGuardScopeVerdict = {
  bypass: boolean;
  reason: ForeignLeaseGuardScopeReason;
};

export type ForeignLeaseGuardScopeInput = {
  /** Rašymo kelias. Kvietėjas jį jau turi būti išsprendęs per `realpath`. */
  filePath: string;
  /** Šio proceso darbo kopijos šaknis, taip pat `realpath` forma. */
  projectRoot: string;
  /** Ar tikslas jau egzistuoja — queue carve-out galioja TIK naujiems failams. */
  targetExists: boolean;
  /** Gyvų (`held`) lease'ų `worktree_path` reikšmės. Į jas rašo gyvas savininkas. */
  liveWorktreePaths?: readonly string[];
};

// Izoliuotų darbo kopijų konteineriai. ŠIO medžio kelias tikrinamas PRISEGTAS prie šaknies:
// laisvas substring'as reikštų, kad bet kur medyje sukurtas `.ag/worktrees/` katalogas išjungia
// fencing'ą visam pomedžiui — ta pati klaidos klasė, kurią 2026-08-06 auditas taisė
// `templates/` carve-out'e.
const WORKTREE_CONTAINER_AT_ROOT = /^\.(?:ag|claude)\/worktrees\/[^/]+(\/|$)/;
/** Gyvo lease'o `worktree_path` yra ABSOLIUTUS, tad konteineris jame ieškomas bet kurioje vietoje. */
const WORKTREE_CONTAINER_ANYWHERE = /(^|\/)\.(?:ag|claude)\/worktrees\/[^/]+(\/|$)/;
const TASK_QUEUE_PREFIX = "ag/tasks/queue/";

/**
 * Lyginimo forma: separatoriai, `..` sutraukimas ir VISADA lowercase.
 *
 * NĖRA `normalizeForPolicy` sinonimas ir pakeisti juo negalima: `normalizeForPolicy` nukerpa
 * `^\.?/`, tad `/repo/x` virstų `repo/x` ir absoliutaus kelio detekcija sugriūtų — visi absoliutūs
 * keliai atrodytų kaip santykiniai šio medžio keliai.
 */
function scopeComparablePath(value: string): string {
  return collapseTraversal(value.replace(/\\/g, "/")).toLowerCase();
}

function isAbsoluteComparablePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:\//.test(value);
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  if (directory === "") return false;
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

/**
 * Ar runtime nuosavybės vartai šiam rašymo keliui APSKRITAI taikomi.
 *
 * Fencing'o tikslas — apsaugoti šio medžio PRODUKTO failus nuo lygiagrečių rašytojų. Trys kelių
 * klasės nė vieno rašytojo darbo neliečia, tad svetimas `held` lease jų neblokuoja:
 *   (a) keliai už `projectRoot` ribų (OS temp, `~/.claude/**` memory katalogai);
 *   (b) kito worktree segmento kopija — atskiras checkout'as;
 *   (c) DAR NEEGZISTUOJANTIS failas po `AG/tasks/queue/**` — eilės papildymas; esamų queue failų
 *       redagavimas/trynimas lieka saugomas.
 *
 * Fail-closed kryptys, uždarančios carve-out'ą pirmiau už bet kurią (a)-(c) šaką: `..` už starto
 * katalogo ir kelias GYVO lease'o worktree viduje. Tikrinamos tik tos `liveWorktreePaths`
 * reikšmės, kurios pačios yra worktree konteineryje — pirminiam medžiui apstampuotas lease kitaip
 * išjungtų visą carve-out'ą.
 */
export function classifyForeignLeaseGuardScope(input: ForeignLeaseGuardScopeInput): ForeignLeaseGuardScopeVerdict {
  if (escapesRoot(input.filePath.replace(/\\/g, "/"))) {
    return { bypass: false, reason: "escapes-root" };
  }

  const root = scopeComparablePath(input.projectRoot);
  // Degeneravusi šaknis (tuščia arba disko šaknis) neturi nė vieno segmento, tad „už šaknies"
  // patikra jai prasmės neturi ir praleistų VISKĄ. Fail-closed: carve-out'o nėra.
  if (root.replace(/^[a-z]:/, "").split("/").filter(Boolean).length === 0) {
    return { bypass: false, reason: "product-tree" };
  }

  const target = scopeComparablePath(input.filePath);
  const absolute = isAbsoluteComparablePath(target) ? target : `${root}/${target}`;

  const liveWorktrees = (input.liveWorktreePaths ?? [])
    .map(scopeComparablePath)
    .filter((worktree) => WORKTREE_CONTAINER_ANYWHERE.test(worktree));
  if (liveWorktrees.some((worktree) => isInsideDirectory(worktree, absolute))) {
    return { bypass: false, reason: "live-worktree" };
  }

  if (!isInsideDirectory(root, absolute)) {
    return { bypass: true, reason: "outside-project-root" };
  }

  const relative = absolute === root ? "" : absolute.slice(root.length + 1);

  if (WORKTREE_CONTAINER_AT_ROOT.test(relative)) {
    return { bypass: true, reason: "foreign-worktree" };
  }

  if (relative.startsWith(TASK_QUEUE_PREFIX)) {
    return input.targetExists
      ? { bypass: false, reason: "existing-queue-file" }
      : { bypass: true, reason: "new-queue-file" };
  }

  return { bypass: false, reason: "product-tree" };
}
