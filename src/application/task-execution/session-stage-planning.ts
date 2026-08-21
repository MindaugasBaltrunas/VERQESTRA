// Kieno darbas patenka į Stop hook'o commit'ą — GRYNAS sprendimas (etalonas: AG_loop
// hooks/on-stop.ts `planSessionStaging`, task 0056 + 0016).
//
// Išskirta iš IO tam, kad VISOS šakos būtų padengiamos be git repo ir be tikro Stop hook'o:
// čia gyvena vienintelė vieta, kurioje sprendžiama, kieno failai bus sucommit'inti, tad ji
// privalo būti tikrinama tiesiogiai.
//
// Trys įrodymų sluoksniai ir jų PRIORITETAS (silpnesnis niekada neperrašo stipresnio):
//   1) NUOSAVYBĖ (session-write owners) — kas failą realiai rašė. Stipriausias.
//   2) SESIJOS baseline — koks buvo medis, kai ŠI sesija startavo.
//   3) TASK baseline — koks buvo medis užduoties aktyvacijoje. Silpniausias, bet vienintelis
//      likęs įrodymas, kai sesijos baseline nebėra.

import { normalizeGitPath, parseDirtyEntries } from "../../domain/git/changes.js";
import {
  sessionBaselineBelongsToSession,
  sessionBaselineWasClean,
  type SessionStartBaseline,
} from "./session-baseline.js";
import {
  sessionStagePlan,
  taskBaselineWasClean,
  unplannedProductPaths,
  type TaskStartBaseline,
} from "./session-staging.js";
import { filterStagePathsByOwnership, type SessionWriteOwners } from "./session-write-owners.js";

export type SessionStagingInput = {
  /** `git status --porcelain --untracked-files=all` išvestis. */
  statusOutput: string;
  sessionWrites: readonly string[];
  owners: SessionWriteOwners;
  sessionBaseline: SessionStartBaseline;
  taskBaseline: TaskStartBaseline;
  /** `current-task-id` — naudojamas TIK kai sesijos baseline savo task'o nepasako. */
  taskId: string;
  /** Dispatch nonce; tuščias = interaktyvi sesija, kuri nieko nemeta. */
  dispatchNonce: string;
};

export type SessionStagingPlan = {
  paths: string[];
  ledgerMisses: string[];
  foreign: string[];
  /** Purvini produkto keliai, kuriuos į planą grąžino ledger-gap saugiklis. */
  gap: string[];
  baselineClean: boolean;
};

export function planSessionStaging(input: SessionStagingInput): SessionStagingPlan {
  // Task tapatybė pirmiausia iš MŪSŲ sesijos baseline: globalus `current-task-id` yra
  // last-writer-wins, tad co-tenant'o dispatch'as juo gali padaryti, kad svetimi keliai mūsų
  // Stop'ui atrodytų kaip „to paties task'o darbas".
  const ownBaseline = sessionBaselineBelongsToSession(input.sessionBaseline, input.dispatchNonce);
  const taskId = (ownBaseline ? (input.sessionBaseline.task_id ?? "") : input.taskId).trim() || input.taskId.trim();
  const identity = { session: input.dispatchNonce, taskId };

  // Filtruojamas LEDGER'IS, o ne galutinis planas: `sessionStagePlan` kontraktas sako, kad
  // runtime/lifecycle keliai stage'inami besąlygiškai — jie yra šio loop'o buhalterija, ne
  // produkto darbas. Filtruojant jau sudėtą planą tracked lifecycle failas, kurį palietė
  // co-tenant'as, liktų necommit'intas ir purvintų medį kitam loop startui.
  const owned = filterStagePathsByOwnership(input.sessionWrites, input.owners, identity);

  // Clean-baseline rescue: sesijos baseline tikslesnis už task lygio (tarp aktyvacijos ir
  // sesijos starto co-tenant'as spėja pridirbti), bet „purvina" jo būsena skaičiuojama tik iš
  // NEPAAIŠKINTO purvo — kitaip retry/repair sesija, mananti pirmojo bandymo darbą svetimu,
  // tyliai išjungtų rescue.
  const baselineClean = ownBaseline
    ? sessionBaselineWasClean(input.sessionBaseline, input.dispatchNonce, new Set(owned.paths.map(normalizeGitPath)))
    : taskBaselineWasClean(input.taskBaseline, input.taskId);

  const plan = sessionStagePlan(input.statusOutput, owned.paths, { baselineClean });

  // Lifecycle/runtime keliai — tie, kuriuos `sessionStagePlan` stage'ina ir su TUŠČIU ledger'iu.
  // Imami iš paties plano, o ne dubliuojant jo taisykles: du sąrašai ilgainiui prasilenktų.
  const lifecycle = new Set(sessionStagePlan(input.statusOutput, [], { baselineClean: false }).paths);
  const foreignSet = new Set(owned.foreign.map(normalizeGitPath));
  const dirty = new Set(parseDirtyEntries(input.statusOutput).map((entry) => entry.path));
  // Įrodytai svetimas PRODUKTO kelias neturi grįžti nė per clean-baseline rescue: baseline sako
  // tik tai, kas buvo MŪSŲ sesijos starte, o nuosavybė sako, kas failą realiai rašė — ir tai
  // stipresnis įrodymas. Be šito filtro rescue sugriebtų co-tenant'o WIP atgal į commit'ą.
  const paths = plan.paths.filter((candidate) => lifecycle.has(candidate) || !foreignSet.has(candidate));
  const gap = resolveLedgerGap(input, paths, foreignSet, ownBaseline);

  return {
    paths: [...paths, ...gap],
    ledgerMisses: plan.ledgerMisses.filter((candidate) => !foreignSet.has(candidate)),
    gap,
    // Skelbiamas tik realiai purvinas ir realiai paliktas kelias: ledger'yje gali gulėti seniai
    // sucommit'intų failų, o lifecycle keliai stage'inami vis tiek — abu vardyti būtų triukšmas.
    foreign: [...foreignSet].filter((candidate) => dirty.has(candidate) && !lifecycle.has(candidate)),
    baselineClean,
  };
}

/**
 * Ledger-gap saugiklis: ledger'is ir baseline yra ĮRODYMŲ sluoksniai, o abu gali būti sunaikinti
 * bandymo VIDURYJE (per-task ledger'io valymas, iš naujo užrašytas sesijos baseline). Tada plane
 * lieka tik lifecycle keliai, o anksti parašyti produkto failai nebyliai nukrenta iš commit'o.
 * `git status` yra vienintelis šaltinis, kurio hook'as negali nusiresetinti.
 *
 * TIK dispatch'intai sesijai: be tapatybės niekas negali būti ĮRODYTA svetimu
 * (`filterStagePathsByOwnership` be sesijos nieko nemeta), tad interaktyviame Stop'e šis
 * saugiklis sušluotų VISĄ medžio purvą į vartotojo commit'ą be jokio nuosavybės įrodymo.
 *
 * Ir TIK tada, kai bandymo starto momento nebežinome. Galiojantis SAVO baseline su nepaaiškintu
 * purvu reiškia, kad co-tenant'as buvo gyvas, tad NIEKAS už ledger'io ribų nestage'inama — ta
 * apsauga lieka stipresnė. Kai baseline'o nebėra, apie co-tenant'ą nėra jokio įrodymo, o apie
 * darbą — yra: jis purvinas medyje.
 */
function resolveLedgerGap(
  input: SessionStagingInput,
  planned: readonly string[],
  foreignSet: ReadonlySet<string>,
  ownBaseline: boolean,
): string[] {
  const attemptStartKnown = ownBaseline && input.sessionBaseline.baseline_valid === true;
  if (!input.dispatchNonce.trim() || attemptStartKnown) return [];

  // MŪSŲ task'o aktyvacijos momento purvas yra vienintelis likęs „ne mūsų darbas" įrodymas: jis
  // užrašytas dar prieš šios sesijos startą, tad tie keliai negali būti šio bandymo rašymai.
  // Svetimo task'o baseline nieko neįrodo — jis galėjo būti užrašytas JAU PO mūsų rašymų.
  const preAttemptDirty = new Set(
    (input.taskBaseline.task_id === input.taskId ? (input.taskBaseline.non_runtime_dirty_entries ?? []) : []).map(
      (entry) => normalizeGitPath(entry.path),
    ),
  );
  return unplannedProductPaths(input.statusOutput, planned).filter(
    (candidate) => !foreignSet.has(candidate) && !preAttemptDirty.has(candidate),
  );
}
