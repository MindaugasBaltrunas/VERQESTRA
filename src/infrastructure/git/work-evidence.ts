// Darbo ĮRODYMO paieška git istorijoje (etalonas: orchestrator/tasks/task-workflow.ts
// `taskWorkEvidenceGrepArgs` / `taskEvidenceRangeArgs` / `evidenceCandidates` /
// `windowProductWorkSha` / `taskCommittedProductWorkSha`).
//
// Klausimas, į kurį šis modulis atsako: „ar šis task'as REALIAI ką nors padarė?". Nuo atsakymo
// priklauso, ar užduotis uždaroma kaip `done` ir ar atrakinami jos priklausiniai — todėl abi
// klaidos NĖRA lygios:
//   - praleistas įrodymas kainuoja vieną sesiją (task'as bėga iš naujo ir nusileidžia į
//     human-review);
//   - MELAGINGAS įrodymas uždaro niekada neįgyvendintą užduotį ir pastato ant jos priklausinius.
// Todėl be įrodomo šio task'o starto pagrindo langas yra TUŠČIAS, o ne visa istorija.

import { splitChildParentStemCandidates } from "../../domain/tasks/identity.js";
import { isWipCommitMessage } from "../../domain/policies/commit-message.js";
import { productPathsFromDiffNames } from "../../domain/git/changes.js";
import { run } from "../process/run-process.js";
import { readTaskStartBaseline } from "../state/task-start-baseline.js";
import type { AttemptResolutionPort } from "../state/attempt-resolution.js";

/** Tuščias intervalas: sintaksiškai galiojantis git range, kuris niekada nieko negrąžina. */
export const EVIDENCE_RANGE_NONE = "HEAD..HEAD";

/**
 * Kiek naujausių kandidatų peržiūrima.
 *
 * Ne `--max-count=1`: naujausias atitikmuo gali būti nukirstos sesijos WIP commit'as, o už jo
 * uodegoje gali gulėti tikras įrodymas. Aibė nuo skeno netampa laisvesnė — ji yra senosios
 * poaibis, tik praleidžiami WIP pažymėtieji.
 */
export const WORK_EVIDENCE_SCAN_LIMIT = 20;

/** POSIX ERE metasimboliai, kad reikšmė būtų matched'inama pažodžiui. */
function escapeExtendedRegExp(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** Ar id nešioja task-splitter'io vaiko sufiksą (`<parentStem>-NN-<slug>`). */
function isSplitChildTaskId(taskId: string): boolean {
  return splitChildParentStemCandidates(taskId).length > 0;
}

/**
 * `git log` grep argumentai šio task'o žymei rasti; `undefined`, kai id neturi numerio.
 *
 * Vaiko id ieškoma TIK pilna forma: `[^0-9-]`, o ne `[^0-9]`, nes `task 1210-x-02-y` yra SPLIT
 * VAIKO žyma, ne šio task'o — kitaip tėvas pasisavintų vaiko darbą.
 *
 * `numberIsUnique` — tik iškviečiantis sluoksnis žino, ar numeris eilėje unikalus (šis modulis
 * to neskaičiuoja); kai `false`, skaičiumi grįsti šablonai praleidžiami, lieka tik pilnas id.
 */
export function taskWorkEvidenceGrepArgs(
  taskId: string,
  numberIsUnique?: boolean,
): string[] | undefined {
  const number = /^(\d+)/.exec(taskId)?.[1];
  if (number === undefined) return undefined;
  const fullId = `--grep=${escapeExtendedRegExp(taskId)}`;
  if (isSplitChildTaskId(taskId) || numberIsUnique === false) {
    return ["--extended-regexp", "--regexp-ignore-case", fullId];
  }
  return [
    "--extended-regexp",
    "--regexp-ignore-case",
    `--grep=\\(${number}\\)`,
    `--grep=task ${number}($|[^0-9-])`,
    fullId,
  ];
}

export type WorkEvidenceInput = {
  projectRoot: string;
  /** vq runtime šaknis — bazės globalus veidrodis gyvena po ja. */
  runtimeRoot: string;
  taskId: string;
  resolution: AttemptResolutionPort;
  /** Neblokuojantis įspėjimas, kai bazė nepasiekiama dėl REALIOS degradacijos. */
  warn?: (line: string) => Promise<void>;
  /** Kai false — praleidžiami skaičiumi grįsti grep šablonai (numeris kartojasi eilėje). */
  numberIsUnique?: boolean;
};

/**
 * Įrodymų paieškos intervalas: commit'ai PO šio task'o starto.
 *
 * Task'ų numeriai kartojasi tarp eilės kartų (užduotys dedupl'inamos pagal turinį, ne pagal
 * numerį), tad plikas `--grep=task 940` pagauna ir ANKSTESNĖS kartos commit'ą. Be intervalo tas
 * senas atitikmuo patvirtintų darbą, kurio šis task'as niekada nedarė.
 */
export async function taskEvidenceRangeArgs(input: WorkEvidenceInput): Promise<string[]> {
  const baseline = await readTaskStartBaseline({
    taskId: input.taskId,
    runtimeRoot: input.runtimeRoot,
    resolution: input.resolution,
    ...(input.warn === undefined ? {} : { warn: input.warn }),
  });
  if (baseline === undefined || baseline.task_id !== input.taskId) return [EVIDENCE_RANGE_NONE];
  const base = (baseline.base_head ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(base)) return [EVIDENCE_RANGE_NONE];
  const verified = await run("git", ["-C", input.projectRoot, "rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    cwd: input.projectRoot,
  });
  return verified.code === 0 ? [`${base}..HEAD`] : [EVIDENCE_RANGE_NONE];
}

export type EvidenceCandidate = { sha: string; message: string };

/**
 * Kandidatai su ŽINUTE, ne vien sha.
 *
 * Žinutė reikalinga tam pačiam sprendimui — ar commit'as nešioja `WIP-Task:` žymę. Ji imama TUO
 * PAČIU `git log` kvietimu (`%H\x1f%B\x1e`), o ne atskiru `git show` kiekvienam sha: skeno riba
 * yra 20, tad atskiri kvietimai reikštų 20 papildomų procesų kiekvienai patikrai.
 *
 * `--invert-grep` čia netinka SĄMONINGAI: git jį taiko VISIEMS to paties kvietimo `--grep`
 * šablonams, tad jis panaikintų task-id atranką. Filtruojama po parsinimo.
 */
export async function evidenceCandidates(
  projectRoot: string,
  logArgs: readonly string[],
  maxCount: number,
): Promise<EvidenceCandidate[]> {
  const log = await run(
    "git",
    ["-C", projectRoot, "log", "--format=%H%x1f%B%x1e", `--max-count=${maxCount}`, ...logArgs],
    { cwd: projectRoot },
  );
  if (log.code !== 0) return [];
  return log.stdout
    .split("\x1e")
    .map((record) => record.replace(/^[\r\n]+/, ""))
    .filter((record) => record.includes("\x1f"))
    .map((record) => {
      const separator = record.indexOf("\x1f");
      return { sha: record.slice(0, separator).trim(), message: record.slice(separator + 1) };
    })
    .filter((candidate) => /^[0-9a-f]{7,40}$/i.test(candidate.sha));
}

/**
 * Naujausias kandidatas, kurio diff'e yra bent vienas PRODUKTO kelias ir kurio žinutė nenešioja
 * WIP žymės.
 *
 * WIP praleidimas galioja ir lango atribucijai („bet kuris šio bandymo commit'as su produkto
 * keliu yra šio bandymo darbas"): kaip tik ji įleistų nukirstos sesijos commit'ą, nes tas
 * produkto kelių turi. Žymė yra vienintelis dalykas, skiriantis pusinį darbą nuo atlikto.
 */
async function firstProductWorkSha(projectRoot: string, logArgs: readonly string[]): Promise<string | undefined> {
  for (const candidate of await evidenceCandidates(projectRoot, logArgs, WORK_EVIDENCE_SCAN_LIMIT)) {
    if (isWipCommitMessage(candidate.message)) continue;
    // `--name-only --format=` duoda vien pakeistų failų sąrašą. Merge commit'as jo neduoda, tad
    // lieka be produkto kelių ir įrodymu netampa — griežtesnė pusė.
    const names = await run("git", ["-C", projectRoot, "show", "--name-only", "--format=", candidate.sha], {
      cwd: projectRoot,
    });
    if (names.code !== 0) continue;
    if (productPathsFromDiffNames(names.stdout).length > 0) return candidate.sha;
  }
  return undefined;
}

/** Lango įrodymas: bet kuris šio bandymo commit'as su produkto keliu (be žinutės grep'o). */
export async function windowProductWorkSha(input: WorkEvidenceInput): Promise<string | undefined> {
  return firstProductWorkSha(input.projectRoot, await taskEvidenceRangeArgs(input));
}

/** Griežtesnis įrodymas: commit'as, kuris ir pažymėtas šiuo task'u, ir turi produkto kelią. */
export async function taskCommittedProductWorkSha(input: WorkEvidenceInput): Promise<string | undefined> {
  const grepArgs = taskWorkEvidenceGrepArgs(input.taskId, input.numberIsUnique);
  if (grepArgs === undefined) return undefined;
  return firstProductWorkSha(input.projectRoot, [...grepArgs, ...(await taskEvidenceRangeArgs(input))]);
}

/** Laisvesnis įrodymas: šiuo task'u pažymėtas ne-WIP commit'as, produkto kelių nereikalaujant. */
export async function taskCommittedWorkSha(input: WorkEvidenceInput): Promise<string | undefined> {
  const grepArgs = taskWorkEvidenceGrepArgs(input.taskId, input.numberIsUnique);
  if (grepArgs === undefined) return undefined;
  const candidates = await evidenceCandidates(
    input.projectRoot,
    [...grepArgs, ...(await taskEvidenceRangeArgs(input))],
    WORK_EVIDENCE_SCAN_LIMIT,
  );
  return candidates.find((candidate) => !isWipCommitMessage(candidate.message))?.sha;
}
