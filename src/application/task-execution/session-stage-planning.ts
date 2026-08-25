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
import { matchesAllowedPath } from "../../domain/tasks/allowed-paths.js";
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
  /**
   * Aktyvaus task'o `## Failai / Leidžiama` aibė (020-a-02). NEPRIVALOMA: be jos
   * allowed-paths fallback'as išjungtas, o visi kiti sprendimai lieka lygiai tokie, kokie buvo.
   */
  allowedPaths?: readonly string[];
};

export type SessionStagingPlan = {
  paths: string[];
  ledgerMisses: string[];
  foreign: string[];
  /** Purvini produkto keliai, kuriuos į planą grąžino ledger-gap saugiklis. */
  gap: string[];
  /** Purvini produkto keliai, kuriuos grąžino allowed-paths fallback'as (020-a-02, R1). */
  fallback: string[];
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
  const fallback = resolveAllowedPathsFallback(input, [...paths, ...gap], identity);

  return {
    paths: [...paths, ...gap, ...fallback],
    ledgerMisses: plan.ledgerMisses.filter((candidate) => !foreignSet.has(candidate)),
    gap,
    fallback,
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

/**
 * Allowed-paths fallback (020-a-02, uždaro R1 iš 020 diagnozės).
 *
 * GEDIMAS, kurį jis taiso: ledger'is yra ĮRANKIO KILMĖS, ne darbo ledger'is — jį pildo tik
 * `Write|Edit` hook kanalas. Darbas, parašytas per `Bash`/`PowerShell` (ar jų paleistą procesą),
 * lieka ledger'iui nematomas, tad Stop hook'as jo ne-stage'ina ir teisingas darbas iškrenta iš
 * commit'o. Abu esami saugikliai išsijungia kaip tik ilgame bandyme: clean-baseline rescue
 * reikalauja švaraus baseline'o, o `resolveLedgerGap` — kad savo baseline'o NEBEBŪTŲ. Šis
 * fallback'as dengia likusią spragą, bet SIAURIAU už abu: vietoj baseline'o įrodymo jis
 * reikalauja SCOPE įrodymo.
 *
 * Įsijungia tik kai galioja VISOS sąlygos vienu metu:
 *   1. sesija dispatch'inta (nonce netuščias) — interaktyviame Stop'e išjungtas visada;
 *   2. žinoma aktyvaus task'o `Leidžiama` aibė ir ji netuščia;
 *   3. VISI ne-runtime purvini `git status` produkto keliai (ne tik kandidatai) telpa į tą aibę —
 *      VIENAS kelias už ribos išjungia fallback'ą VISIŠKAI, ne dalinai: svetimas purvas medyje
 *      reiškia, kad scope įrodymas nebeatskiria mūsų darbo nuo co-tenant'o;
 *   4. joks kandidatas nėra įrodytai svetimas (owners) — svetimumas stipresnis už scope;
 *   5. kandidatas nebuvo purvinas jau task'o aktyvacijoje (tas purvas įrodytai ne šio bandymo).
 *
 * Kiekvieną suveikimą kvietėjas skelbia garsia `STAGING LEDGER FALLBACK` eilute — fallback'as
 * niekada nebūna tylus.
 */
function resolveAllowedPathsFallback(
  input: SessionStagingInput,
  planned: readonly string[],
  identity: { session: string; taskId: string },
): string[] {
  if (!input.dispatchNonce.trim()) return [];
  const allowed = (input.allowedPaths ?? []).map(normalizeTaskPathPattern).filter((pattern) => pattern !== "");
  if (allowed.length === 0) return [];

  const candidates = unplannedProductPaths(input.statusOutput, planned);
  if (candidates.length === 0) return [];

  // Sąlyga 3 tikrinama prieš VISĄ produkto purvą, ne tik prieš kandidatus: jau suplanuotas, bet
  // už scope ribų esantis kelias lygiai taip pat įrodo, kad medyje yra ne šio task'o darbo.
  const allProductDirt = unplannedProductPaths(input.statusOutput, []);
  const fitsScope = (candidate: string): boolean => allowed.some((pattern) => matchesAllowedPath(candidate, pattern));
  if (!allProductDirt.every(fitsScope)) return [];

  // Svetimumas tikrinamas TIESIAI per owners sidecar'ą, ne per ledger'io foreignSet: šio
  // fallback'o prielaida ir yra tuščias/nepilnas ledger'is, tad iš jo išvestas foreignSet čia
  // nieko nemato. Kanoninis filtras tas pats kaip pagrindiniame plane — svetimumo apibrėžimas
  // negali skirtis pagal tai, kuris saugiklis klausia.
  if (filterStagePathsByOwnership(candidates, input.owners, identity).foreign.length > 0) return [];

  const preAttemptDirty = new Set(
    (input.taskBaseline.task_id === input.taskId ? (input.taskBaseline.non_runtime_dirty_entries ?? []) : []).map(
      (entry) => normalizeGitPath(entry.path),
    ),
  );
  return candidates.filter((candidate) => !preAttemptDirty.has(candidate));
}

/** Ta pati normalizacija kaip diagnozės pusėje (`dispositions.ts`): markdown backtick'ai kerpami. */
function normalizeTaskPathPattern(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^`|`$/g, "").trim();
}
