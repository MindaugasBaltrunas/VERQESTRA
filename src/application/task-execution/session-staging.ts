// Stop staging'o GRYNOS taisyklės: ką Stop hook'as gali `git add` (etalonas: AG_loop
// orchestrator/git/session-staging.ts, task 890 + 1100 + 0016). VERQESTRA skirtumai:
// lifecycle prefiksas — vq/architecture/generated/. Pats staging'o vykdymas — E5 hooks.

import { isRuntimePath, normalizeGitPath, parseDirtyEntries, type DirtyEntry } from "../../domain/git/changes.js";

/** `task-start-status.json` poaibis, kurio reikia Stop staging apsaugai. */
export type TaskStartBaseline = {
  task_id?: string;
  baseline_valid?: boolean;
  non_runtime_dirty_entries?: DirtyEntry[];
};

/**
 * True, kai task-start baseline įrodo, kad ŠIS task'as prasidėjo ant švaraus worktree:
 * git status momentinė kopija pavyko (`baseline_valid`), neužfiksavo ne-runtime dirty
 * įrašų ir priklauso BŪTENT tam task'ui, kurį Stop hook'as uždaro. Task-id atitikmuo
 * svarbus — interaktyvi sesija ar pasenęs kito task'o baseline apie dabartinį worktree
 * nesako nieko, tad jiems lieka griežtas ledger-only staging'as.
 */
export function taskBaselineWasClean(baseline: TaskStartBaseline, taskId: string): boolean {
  if (!taskId || baseline.task_id !== taskId) return false;
  return baseline.baseline_valid === true && (baseline.non_runtime_dirty_entries ?? []).length === 0;
}

/**
 * Track'inami orkestratoriaus generuojami artefaktai, kurie važiuoja commit'uose, bet
 * NĖRA runtime prefiksuose: architektūros kodo žemėlapiai regeneruojami tarp taskų (ne
 * per Claude Write/Edit, tad niekada ne sesijos ledger'yje). Ranka autorinti failai
 * kitur po vq/architecture eina per ledger'į kaip normalūs produkto edit'ai.
 */
const stageableLifecyclePrefixes = ["vq/architecture/generated/"];

function isStageableLifecyclePath(filePath: string): boolean {
  return stageableLifecyclePrefixes.some((prefix) => filePath === prefix.slice(0, -1) || filePath.startsWith(prefix));
}

export type SessionStagePlan = {
  /** Keliai, kuriuos Stop hook'as gali `git add` (prieš gitignore filtrą). */
  paths: string[];
  /**
   * Dirty produkto keliai, stage'inti BE ledger įrašo — išgelbėti clean-baseline apsaugos.
   * Netuščias reiškia, kad rašymo ledger'is prarado įrašų — Stop hook'as juos loggina,
   * kad regresija liktų matoma.
   */
  ledgerMisses: string[];
};

/**
 * Pathspec'as, kurį Stop hook'as gali stage'inti (task 890). Pakeičia besąlyginį
 * `git add --all`, kuris šluodavo lygiagrečios sesijos produkto edit'us į šio task'o
 * commit'ą (regresija 875, tada 884–893 failų praradimas). Dirty kelias stage'inamas tik:
 *   - runtime/lifecycle kelias ({@link isRuntimePath}) — šio loop'o buhalterija; arba
 *   - įrašytas ŠIOS sesijos rašymo ledger'yje (`sessionWrites`).
 * Kiti dirty produkto keliai — svetimas worktree darbas, lieka nestage'inti.
 *
 * `baselineClean` — clean-baseline apsauga (2026-08-04, task 1100 incidentas): kai
 * task-start baseline užfiksavo validų, švarų worktree ŠIAM task'ui, jokia lygiagreti
 * sesija negalėjo turėti dirty produkto failo — tada ledger'yje trūkstamas dirty produkto
 * kelias yra ledger spraga, ne svetimas darbas, ir jo stage'inimas geresnis už tylų
 * dalinį commit'ą. Su NE-švariu baseline elgesys nekinta.
 */
export function sessionStagePlan(
  statusOutput: string,
  sessionWrites: readonly string[],
  options: { baselineClean: boolean } = { baselineClean: false },
): SessionStagePlan {
  const ledger = new Set(sessionWrites.map((file) => normalizeGitPath(file)).filter((file) => file.length > 0));
  const paths: string[] = [];
  const ledgerMisses: string[] = [];

  for (const entry of parseDirtyEntries(statusOutput)) {
    if (isRuntimePath(entry.path) || isStageableLifecyclePath(entry.path) || ledger.has(entry.path)) {
      paths.push(entry.path);
      continue;
    }
    if (options.baselineClean) {
      paths.push(entry.path);
      ledgerMisses.push(entry.path);
    }
  }

  return { paths: Array.from(new Set(paths)), ledgerMisses: Array.from(new Set(ledgerMisses)) };
}

/**
 * Dirty PRODUKTO keliai, kurių nedengia jokia `plannedPaths` taisyklė — paskutinės
 * instancijos Stop staging plano pilnumo DETEKTORIUS (task 0016). Ledger'is ir
 * clean-baseline gelbėjimas yra evidencijos sluoksniai; kai evidencija sunaikinama
 * mid-attempt, abu nutyla kartu, o git status — vienintelis šaltinis, kurio hook'as
 * negali resetinti. Sprendimą priima kvietėjas (proven-foreign ownership laimi).
 */
export function unplannedProductPaths(statusOutput: string, plannedPaths: readonly string[]): string[] {
  const planned = new Set(plannedPaths.map((file) => normalizeGitPath(file)));
  const gap: string[] = [];
  for (const entry of parseDirtyEntries(statusOutput)) {
    if (isRuntimePath(entry.path) || isStageableLifecyclePath(entry.path)) continue;
    if (planned.has(entry.path)) continue;
    gap.push(entry.path);
  }
  return Array.from(new Set(gap));
}

// 2026-08-24: `sessionStagePaths` PAŠALINTA. Ji buvo pre-1100 kontrakto vaizdas „kvietėjams be
// apsaugos" ir produkcinio kvietėjo neturėjo — visi keliai eina per `sessionStagePlan`, kuris
// grąžina ne tik `paths`, bet ir apsaugos sprendimą. Plikas `paths` vaizdas buvo tyliai
// silpnesnis: jis atmesdavo būtent tą informaciją, dėl kurios 1100 kontraktas ir atsirado.

/**
 * Failai, iš kurių Stop hook'as generuoja AUTOMATINĘ commit žinutę (etalono 2026-07-29
 * pamoka: žinutė vardijo produkto failus, kurie NEBUVO stage'inami). Žinutė privalo
 * apibūdinti tik tai, kas realiai commit'inama: pirmenybė stage'intiems PRODUKTO failams;
 * kai jų nėra — patys stage'inti lifecycle keliai.
 */
export function honestAutoCommitFiles(stagePaths: readonly string[]): string[] {
  const product = stagePaths.filter((file) => !isRuntimePath(file) && !isStageableLifecyclePath(file));
  return (product.length > 0 ? product : [...stagePaths]).sort();
}
