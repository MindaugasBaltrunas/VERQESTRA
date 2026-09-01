// Deterministinis pre-loop guard (etalonas: AG_loop orchestrator/loop/loop-preconditions.ts).
// Veikia PRIEŠ bet kokį task'o judinimą, todėl block'as čia negali sudeginti eilės — loop
// tiesiog nepradedamas. Etalone modulis pats kvietė git/fs/dist įrankius; VERQESTRA visi
// efektai ateina per LoopPreconditionPorts (E4 adapteriai, suriša VQ-504 kompozicija), o
// grynos taisyklės (stale index.lock riba, blokatorių klasifikacija, produkto dirty filtras
// per domain/git/changes) lieka čia testuojamos be jokios FS.

import path from "node:path";
import { nonRuntimeDirtyEntriesFromStatus, type DirtyEntry } from "../../domain/git/changes.js";

export type LoopCheckSeverity = "block" | "warn";

export type LoopCheck = {
  name: string;
  ok: boolean;
  severity: LoopCheckSeverity;
  detail: string;
  fix?: string;
};

export type LoopPreconditionReport = {
  ok: boolean;
  checks: LoopCheck[];
  /**
   * Higienos žingsnių (dead-owner lease reaper) pėdsakas. Tai NE vartai: eilutės tik
   * pasakoja, kas buvo sutvarkyta prieš tikrinant, ir niekada nekeičia `ok`.
   */
  notes: string[];
};

/** Higienos žingsnis, kurį {@link evaluateLoopPreconditions} vykdo PRIEŠ blokuojančius vartus. */
export type LoopPreconditionHygiene = {
  reapDeadLeases?: (projectRoot: string, now: Date) => Promise<string[]>;
};

/** Pre-loop patikrų IO portai. Visi keliai absoliutūs; klaidas verčia reikšmėmis kvietėjas. */
export type LoopPreconditionPorts = {
  isGitRepository(projectRoot: string): Promise<boolean>;
  /** `git status --porcelain --untracked-files=all` išvestis; code !== 0 = git nepasiekiamas. */
  gitStatusPorcelain(projectRoot: string): Promise<{ code: number; stdout: string }>;
  /** Absoliutus `.git` katalogo kelias arba `undefined`, kai jo išspręsti nepavyko. */
  resolveGitDir(projectRoot: string): Promise<string | undefined>;
  /** FAILO mtime ms arba `undefined`, kai kelio nėra ar tai ne failas. */
  fileMtimeMs(absolutePath: string): Promise<number | undefined>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  gitCommitExists(ref: string, projectRoot: string): Promise<boolean>;
  /** Pasenę/trūkstami dist failai orchestratoriaus šaknyje; `[]` = šviežia. */
  findStaleDistFiles(orchestratorRoot: string): Promise<Array<{ sourcePath: string }>>;
};

// Pakibęs .git/index.lock be gyvo git proceso laužo Stop-hook commit'us (etalono pamoka:
// stale-index-lock sudegino 208/209 į human-review). Šviežias lock'as (jaunesnis nei riba)
// gali priklausyti aktyviam git procesui — jo nelaikom stale.
const STALE_INDEX_LOCK_MS = 60_000;

export function isStaleIndexLock(lockMtimeMs: number, now: number, thresholdMs = STALE_INDEX_LOCK_MS): boolean {
  return now - lockMtimeMs >= thresholdMs;
}

export function classifyLoopBlockers(checks: LoopCheck[]): LoopCheck[] {
  return checks.filter((check) => check.severity === "block" && !check.ok);
}

export function loopPreconditionsOk(checks: LoopCheck[]): boolean {
  return classifyLoopBlockers(checks).length === 0;
}

/**
 * Necommit'inti PRODUKTO (ne runtime) failai darbiniame medyje. Naudojama ir pre-loop
 * guard'o, ir loop ciklo TARP task'ų: ankstesnio task'o infra_abort/timeout palikti failai
 * kitaip užteršia kito task'o sesiją (etalono GeoGravity 1040-02/1045 pamoka — geras darbas
 * rollback'inamas dėl svetimų failų).
 */
export async function productTreeDirtyEntries(
  ports: Pick<LoopPreconditionPorts, "gitStatusPorcelain">,
  projectRoot: string,
): Promise<DirtyEntry[]> {
  const status = await ports.gitStatusPorcelain(projectRoot);
  return status.code === 0
    ? nonRuntimeDirtyEntriesFromStatus(status.stdout)
    : [{ status: "!!", path: "<git status failed>" }];
}

/**
 * Pre-loop vartai: git repo, šviežias dist, švarus produkto medis, jokio stale index.lock,
 * validus stable-ref. PRIEŠ vartus vykdoma viena higienos operacija — mirusio savininko
 * worker lease'ų atlaisvinimas (etalono task 0025): nutrūkęs dispatch'as palieka ir purviną
 * failą, ir `held` lease — be higienos clean-tree block'as užrakintų vienintelį kelią jį
 * atlaisvinti. Higienos rezultatas keliauja į `notes`, niekada į `checks`.
 *
 * `stateDir` — VERQESTRA runtime state katalogas (`vq/state`; ten gyvena `stable-ref`).
 */
export async function evaluateLoopPreconditions(
  ports: LoopPreconditionPorts,
  projectRoot: string,
  orchestratorRoot: string,
  stateDir: string,
  now: number = Date.now(),
  hygiene: LoopPreconditionHygiene = {},
): Promise<LoopPreconditionReport> {
  const checks: LoopCheck[] = [];
  const notes: string[] = [];

  const isRepo = await ports.isGitRepository(projectRoot);
  checks.push({
    name: "git-repository",
    ok: isRepo,
    severity: "block",
    detail: isRepo ? "git repository detected" : "not a git repository",
    ...(isRepo ? {} : { fix: "run the loop from the product repository root" }),
  });

  if (!isRepo) {
    return { ok: loopPreconditionsOk(checks), checks, notes };
  }

  if (hygiene.reapDeadLeases) {
    // Reaper'is savo klaidas jau paverčia eilute; `catch` čia yra antras diržas, kad joks
    // netikėtas metimas nevirstų nauju loop starto blokatoriumi (etalono AC 6).
    notes.push(
      ...(await hygiene.reapDeadLeases(projectRoot, new Date(now)).catch((error: unknown) => [
        `LEASE REAP FAILED: ${error instanceof Error ? error.message : String(error)}`,
      ])),
    );
  }

  // NEŽINIA apie dist šviežumą yra blokas, lygiai kaip pats pasenęs dist (2026-09-01 auditas).
  // Iki tol čia buvo `catch(() => [])`: neperskaitomas build stamp'as duodavo TUŠČIĄ sąrašą, tad
  // vartas praleisdavo pasenusį dist kaip šviežią — o loop'as ir hook'ai vykdo būtent `dist`.
  // Gretimas reaper'io `catch` (aukščiau) klaidą ryja teisėtai: jis yra higiena, ne vartai.
  const staleDist = await ports
    .findStaleDistFiles(orchestratorRoot)
    .then((files) => ({ scanned: true as const, files }))
    .catch((error: unknown) => ({
      scanned: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
  const distFresh = staleDist.scanned && staleDist.files.length === 0;
  checks.push({
    name: "fresh-dist",
    ok: distFresh,
    severity: "block",
    detail: !staleDist.scanned
      ? `dist freshness unknown: ${staleDist.reason}`
      : distFresh
        ? "orchestrator dist is up to date"
        : `${staleDist.files.length} stale/missing dist file(s), e.g. ${path.basename(staleDist.files[0]!.sourcePath)}`,
    ...(distFresh ? {} : { fix: "rebuild the orchestrator dist" }),
  });

  const dirty = await productTreeDirtyEntries(ports, projectRoot);
  checks.push({
    name: "clean-tree",
    ok: dirty.length === 0,
    severity: "block",
    detail:
      dirty.length === 0
        ? "no uncommitted product changes"
        : `${dirty.length} uncommitted product file(s): ${dirty.slice(0, 5).map((entry) => entry.path).join(", ")}`,
    ...(dirty.length === 0 ? {} : { fix: "commit or stash product changes, or run from a single dedicated session" }),
  });

  const gitDir = await ports.resolveGitDir(projectRoot);
  let lockOk = true;
  let lockDetail = "no git index.lock";
  if (gitDir) {
    const lockPath = path.join(gitDir, "index.lock");
    const lockMtime = await ports.fileMtimeMs(lockPath);
    if (lockMtime !== undefined) {
      if (isStaleIndexLock(lockMtime, now)) {
        lockOk = false;
        lockDetail = `stale ${path.relative(projectRoot, lockPath)} (age ${Math.round((now - lockMtime) / 1000)}s)`;
      } else {
        lockDetail = "git index.lock present but fresh — a git process may be active";
      }
    }
  }
  checks.push({
    name: "no-stale-index-lock",
    ok: lockOk,
    severity: "block",
    detail: lockDetail,
    ...(lockOk ? {} : { fix: "remove .git/index.lock manually after confirming no git process is running" }),
  });

  const stableRef = ((await ports.readTextFileIfExists(path.join(stateDir, "stable-ref"))) ?? "").trim();
  const stableOk = stableRef.length > 0 && (await ports.gitCommitExists(stableRef, projectRoot));
  checks.push({
    name: "valid-stable-ref",
    ok: stableOk,
    severity: "block",
    detail: stableOk ? `stable-ref -> ${stableRef.slice(0, 12)}` : "stable-ref missing or not a valid commit",
    ...(stableOk ? {} : { fix: "git rev-parse HEAD > vq/state/stable-ref" }),
  });

  return { ok: loopPreconditionsOk(checks), checks, notes };
}

/** Etalono `printLoopPreconditionReport` eilutės (spausdina kvietėjas — interfaces). */
export function renderLoopPreconditionReport(report: LoopPreconditionReport): string[] {
  const lines: string[] = [];
  for (const note of report.notes) {
    lines.push(`NOTE  ${note}`);
  }
  for (const check of report.checks) {
    const mark = check.ok ? "OK   " : check.severity === "block" ? "BLOCK" : "WARN ";
    lines.push(`${mark} ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`       fix: ${check.fix}`);
    }
  }
  lines.push(report.ok ? "AG_LOOP_PRECONDITIONS_OK" : "AG_LOOP_PRECONDITIONS_BLOCKED");
  return lines;
}
