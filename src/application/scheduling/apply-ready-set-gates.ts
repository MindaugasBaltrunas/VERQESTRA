// Kanoninio grafo vartai virš bangos plano (task 0001; spec PDAG-1/WAVE-1, design §9-§10).
// Behaviour etalon: AG_loop application/scheduling/apply-ready-set-gates.ts (1:1).
//
// Sistemoje yra DU sprendimų autoriai: schedule-next-wave sako „kokia yra ŠIOS bangos
// tvarka", build-ready-set — „kuriuos kanoninio grafo mazgus apskritai LEIDŽIAMA vykdyti".
// Naivus jų sujungimas būtų regresija (semantikos skiriasi sąmoningai), todėl vartai
// taikomi IŠORĖJE ir tik viena kryptimi: šis modulis gali task'ą PAŠALINTI iš `plan.ready`,
// bet niekada jo ten neįdeda ir niekada nekeičia likusiųjų tvarkos. Modulis grynas.
import { READY_SET_BLOCKED_REASONS, type BlockedTask, type ReadySet, type ReadySetBlockedReason } from "./build-ready-set.js";
import {
  clampWaveWorkers,
  computeGraphHash,
  normalizeSchedulableTasks,
  waveIdFor,
  WAVE_SCHEDULER_VERSION,
  type SchedulableTask,
  type WaveBlockedReason,
  type WaveBlockedTask,
  type WavePlan,
} from "./schedule-next-wave.js";
import { computeWaveDecisionHash } from "./wave-decision-hash.js";

/** Grafo vartas, kurį leidžiama taikyti bangos planui. Vardai bendri su `buildReadySet`. */
export type ReadySetGate = ReadySetBlockedReason;

/**
 * Numatytoji politika: VISOS kanoninio grafo priežastys.
 *
 * NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23 auditas). Etalone — ir VERQESTRA iki šios
 * dienos — numatytasis rinkinys buvo `["budget-exhausted", "budget-insufficient"]`, o pagrindimas
 * skambėjo taip: likusios priežastys remiasi grafo semantika, kuri su bangos semantika nesutampa,
 * tad jų įjungimas esąs „eksplicitus iškvietėjo sprendimas". Praktikoje to sprendimo nepriėmė
 * NIEKAS: nei etalono, nei VERQESTRA produkcinis wiring'as `readySetPolicy` niekada nepadavė, tad
 * `graph-invalid`, `missing-dependency`, `dependency-cycle`, `invalid-terminal-dependency` ir
 * `approval-required` verdiktai buvo skaičiuojami ir išmetami. Atkurta realiai:
 *
 *   priklausomybė į neegzistuojantį task'ą → grafas: `missing-dependency`, produkcija: VYKDOMA;
 *   `a → a`                               → grafas: neįvykdomas,          produkcija: VYKDOMA;
 *   `a(queue) → b(human-review) → a`      → grafas: neįvykdomas,          produkcija: VYKDOMA.
 *
 * Numatytoji reikšmė, kurią reikia „įjungti", kad ji ką nors saugotų, nėra vartai. Todėl kryptis
 * apversta: numatytai galioja VISKAS, ką kanoninis grafas atmeta, o susiaurinti gali tik
 * eksplicitus `enforce` (pvz. testai, tiriantys vieną priežastį).
 *
 * Bangos semantikos skirtumas išlieka ir yra būtent tai, ką vartai uždaro: `scheduleNextWave`
 * sąmoningai atlaidus (savęs nuoroda nuimama, eilėje nesantis blokatorius laikomas įvykdytu,
 * dviprasmiškas prefiksas sprendžiamas pirmu kandidatu), tad be šių vartų atlaidžioji pusė turėjo
 * paskutinį žodį. Dabar planuoklis atsako „kokia TVARKA", o grafas — „ar apskritai LEIDŽIAMA".
 */
export const DEFAULT_READY_SET_GATES: readonly ReadySetGate[] = READY_SET_BLOCKED_REASONS;

export type ReadySetGatePolicy = {
  /** Priežastys, kurias vartai taiko. Nenurodžius — {@link DEFAULT_READY_SET_GATES}. */
  enforce?: Iterable<ReadySetGate>;
};

/**
 * Uždeda grafo vartus ant jau sudaryto bangos plano.
 *
 * Invariantai (visi privalomi, visi vienakrypčiai):
 *   - SUBTRACT-ONLY: task'as gali pereiti tik `ready → blocked`; grafas negali atrakinti
 *     lūžusios šakos.
 *   - Likusių `ready` tvarka nekeičiama; bangos tapatybė — irgi.
 *   - SANKIRTA, ne atimtis: leidžiama tik tai, ką kanoninis grafas VARDIJA kaip `ready`.
 *   - Kai šalinamų nėra, grąžinamas TAS PATS objektas — nuorodos tapatybė yra įrodymas
 *     „vartai nieko nepakeitė".
 *
 * NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23 auditas, operatoriaus radinys). Iki šiol
 * vartai tik ATIMDAVO `readySet.blocked` narius, o `readySet.ready` visai neskaitydavo. Trečias
 * tos pačios klaidos pavidalas tame pačiame faile: numatytoji politika nieko nedraudė, neimportuotas
 * grafas nieko nedraudė, o dabar paaiškėjo, kad ir pats grafas buvo tik DRAUDIMŲ sąrašas. Todėl
 * task'as pralįsdavo pro VISUS vartus vien nebūdamas grafe. Atkurta realiai:
 *
 *   grafe task'o NĖRA  → canonical_ready=[], canonical_blocked=[], galutinis ready=["a"];
 *   grafe jau `done`   → canonical_ready=[], canonical_blocked=[], galutinis ready=["a"].
 *
 * `done` atvejis yra blogesnis už „nėra": `buildReadySet` užbaigtą mazgą praleidžia (jis tenkina
 * priklausomybes), tad jis nepatenka NĖ Į VIENĄ sąrašą — ir jau atliktas task'as būtų vykdomas iš
 * naujo. Tai ne teorija: `wave-scheduler` eilės task'us (`readTasks`) ir kanoninį Markdown grafą
 * (`refresh`) skaito ATSKIRAIS FS skaitymais skirtingu metu, tad tarp jų task'as spėja persikelti
 * tarp bucket'ų.
 *
 * Buvęs pagrindimas — „nebuvimas nėra draudimas, o nepilna informacija" — yra tiksliai ta pati
 * fail-open logika, kurią šiandien jau apvertėme dukart: nepilna informacija reiškia, kad leidimo
 * ĮRODYTI negalime, o be įrodymo nevykdoma. Todėl toks task'as blokuojamas vardu
 * `gate:graph-state-mismatch` — atskiru nuo grafo verdiktų, nes tai ne grafo sprendimas apie
 * task'ą, o dviejų šaltinių NESUTAPIMAS, ir operatoriui tai skirtingas gedimas.
 */
export function applyReadySetGates(plan: WavePlan, readySet: ReadySet | undefined, policy?: ReadySetGatePolicy): WavePlan {
  const enforced = new Set<ReadySetGate>(policy?.enforce ?? DEFAULT_READY_SET_GATES);
  // Sprendimo atspaudas stampuojamas VISADA, net kai nieko nešalinama.
  //
  // Iki 2026-08-23 ši funkcija, nieko nepašalinusi, grąžindavo TĄ PATĮ objektą, ir nuorodos
  // tapatybė buvo prikalta kaip invariantas „vartai nieko nepakeitė". Tas invariantas tiesiogiai
  // prieštarauja `decision_hash` prasmei: vartai, praleidę visus task'us, VIS TIEK priėmė
  // sprendimą, ir planas privalo tai nešti. Priešingu atveju atspaudas sakytų „be vartų" ten, kur
  // vartai suveikė ir viską patvirtino — t. y. atkartotų būtent tą klaidą, kurią taiso.
  // SUBTRACT-ONLY galioja toliau; keičiasi tik tai, kad tapatybė nebėra įrodymas.
  if (!readySet) {
    return {
      ...plan,
      decision_hash: computeWaveDecisionHash({
        waveGraphHash: plan.graph_hash,
        enforced,
        ready: plan.ready,
        blocked: plan.blocked,
      }),
    };
  }

  const gates = new Map<string, BlockedTask>();
  for (const entry of readySet.blocked) gates.set(entry.task_id, entry);
  const permitted = new Set<string>(readySet.ready.map((task) => task.task_id));

  const removed: WaveBlockedTask[] = [];
  const ready = plan.ready.filter((task) => {
    const gate = gates.get(task.task_id);
    if (gate !== undefined) {
      // Grafe task'as YRA ir yra sustabdytas. Ar tai taikoma, sprendžia politika: susiaurintas
      // `enforce` sąmoningai palieka dalį verdiktų neveikiančių (tuo naudojasi taikiniai testai).
      if (!enforced.has(gate.reason)) return true;
      removed.push({
        task_id: task.task_id,
        file: task.file,
        // `blocked_by` imamas iš BANGOS įrašo: snapshot'o skaitytojui priklausomybės turi
        // atrodyti taip pat, nesvarbu, kuris sluoksnis task'ą sustabdė.
        blocked_by: [...task.blocked_by],
        // `gate:` prefiksas atskiria grafo vartą nuo bangos taisyklės — dvi skirtingos
        // priežastys niekada nesusilieja į vieną vardą.
        reason: `gate:${gate.reason}`,
        waiting_for: [...gate.waiting_for],
      });
      return false;
    }

    if (permitted.has(task.task_id)) return true;

    // NĖ VIENAME sąraše: bangos ir grafo būsenos išsiskyrė. Tai NĖRA politikos klausimas, tad
    // `enforce` šio varto nesusiaurina — susiaurinti galima verdiktą, bet ne autoriteto trūkumą.
    removed.push({
      task_id: task.task_id,
      file: task.file,
      blocked_by: [...task.blocked_by],
      reason: "gate:graph-state-mismatch",
      waiting_for: [],
    });
    return false;
  });

  // Jau sustabdytų task'ų priežastys SUDERINAMOS su kanoniniu verdiktu (2026-08-23, operatoriaus
  // radinys). Iki tol vartai lietė tik `plan.ready`, tad task'as, kurį sustabdė ABI pusės, plane
  // likdavo su bendresne bangos priežastimi: `unsatisfied-dependency` ten, kur grafas žinojo
  // `missing-dependency` arba `invalid-terminal-dependency`. Vykdymas buvo saugus — task'as bet
  // kuriuo atveju blokuotas, — bet operatoriaus pranešimai ir automatika, skaitanti priežasties
  // kodą, gaudavo mažiau tikslų atsakymą.
  const reconciled = plan.blocked.map((entry) => reconcileReason(entry, gates, enforced));
  // Ta pati rūšiavimo taisyklė kaip `scheduleNextWave` (pagal failą), kad sujungtas sąrašas
  // liktų vienoje deterministinėje tvarkoje.
  const blocked = [...reconciled, ...removed].sort((a, b) => a.file.localeCompare(b.file));

  // Atspaudas stampuojamas PO galutinio surinkimo: jis privalo aprašyti tą planą, kurį objektas
  // neša, o ne tarpinę ready-set būseną.
  const decisionHash = computeWaveDecisionHash({ waveGraphHash: plan.graph_hash, readySet, enforced, ready, blocked });
  const changed = reconciled.some((entry, position) => entry !== plan.blocked[position]);
  if (removed.length === 0 && !changed) return { ...plan, decision_hash: decisionHash };

  return { ...plan, decision_hash: decisionHash, ready, blocked };
}

/**
 * Bangos priežastys, kurių kanoninis grafas PAGERINTI NEGALI.
 *
 * `branch-blocked` yra šio RUN'O faktas: grafas jį mato tik per `statusOverrides` kaip `blocked`,
 * o iš to gimsta bendrinis `not-queued` — griežtai mažiau informatyvu. `gate:graph-unavailable` ir
 * `gate:graph-state-mismatch` reiškia, kad kanoninio verdikto šiam task'ui apskritai NĖRA.
 *
 * Todėl taisyklė nėra „kanoninis visada laimi": laimi TIKSLESNIS, o tikslumo kryptis priklauso nuo
 * to, kuris sluoksnis apskritai gali tą faktą pasakyti.
 */
const WAVE_OWNED_REASONS: ReadonlySet<string> = new Set([
  "branch-blocked",
  "gate:graph-unavailable",
  "gate:graph-state-mismatch",
]);

/**
 * Priežasčių prioritetas vienam jau sustabdytam task'ui:
 *   1. bangai priklausančios priežastys (žr. `WAVE_OWNED_REASONS`) — nekeičiamos;
 *   2. kanoninis verdiktas, jei jis YRA ir jį taiko politika — laimi kaip tikslesnis;
 *   3. kitu atveju lieka bangos priežastis.
 *
 * `blocked_by` visada iš BANGOS įrašo — ta pati taisyklė kaip pašalinant iš `ready`; `waiting_for`
 * imamas iš kanoninio, nes būtent jis vardija konkrečias nuorodas.
 */
function reconcileReason(
  entry: WaveBlockedTask,
  gates: ReadonlyMap<string, BlockedTask>,
  enforced: ReadonlySet<ReadySetGate>,
): WaveBlockedTask {
  if (WAVE_OWNED_REASONS.has(entry.reason)) return entry;
  const gate = gates.get(entry.task_id);
  if (gate === undefined || !enforced.has(gate.reason)) return entry;

  // Perrašoma TIK tada, kai kanoninis sako KĄ KITA. Jei abi pusės pasakė tą patį (`005` laukia
  // `004` ir bangai, ir grafui), `gate:` prefiksas nepridėtų tikslumo — jis tik pakeistų, KIENO
  // vardu tas pats faktas paskelbtas. Prefikso prasmė yra „grafas pasakė tai, ko banga nežinojo";
  // jį klijuojant visur, jis nustotų ką nors reikšti. Patikrinta gyvame repo: be šios sąlygos
  // penki task'ai būtų gavę `gate:unsatisfied-dependency` vietoj `unsatisfied-dependency` be
  // jokios naudos skaitytojui.
  const bare = entry.reason.startsWith("gate:") ? entry.reason.slice("gate:".length) : entry.reason;
  if (bare === gate.reason) return entry;

  return { ...entry, reason: `gate:${gate.reason}` satisfies WaveBlockedReason, waiting_for: [...gate.waiting_for] };
}

/** `scheduleNextWave` įėjimas be grafo — tiek, kiek reikia bangos tapatybei ir sąrašui. */
export type WaveWithoutGraphInput = {
  tasks: readonly SchedulableTask[];
  waveSequence?: number;
  maxWorkers?: number;
};

/**
 * Banga be kanoninio grafo: NĖ VIENAS task'as nevykdomas.
 *
 * NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23 auditas). Iki šiol neimportuotas grafas
 * reiškė `readySet === undefined`, o tai — „vartų nėra", tad banga eidavo VISAI be kanoninių
 * draudimų. Pagrindimas buvo „sustabdyta eilė dėl neperskaityto pagalbinio failo būtų blogesnis
 * mainas", ir jis galiojo tol, kol grafas buvo tik diagnostika. Nuo tada, kai grafas yra vartai,
 * jis apsivertė: negalėdami perskaityti autoriteto, negalime ĮRODYTI, kad task'ą leidžiama
 * vykdyti, o spėti čia draudžia ta pati taisyklė kaip visame ready-set kelyje.
 *
 * Importas nelūžta dėl to, kad bucket'o nėra (adapteris tokiu atveju grąžina tuščią sąrašą), tad
 * ši šaka reiškia tikrą gedimą: neperskaitomą task failą arba mazgą be panaudojamo id.
 *
 * Nuo 3/3 suvienodinimo žingsnio tai KONSTRUKTORIUS, o ne transformacija: `scheduleNextWave` be
 * grafo nebeegzistuoja, tad plano, kurį būtų galima „apkarpyti", šioje šakoje paprasčiausiai nėra.
 * Bangos tapatybė skaičiuojama iš to paties eilės pjūvio, tad snapshot'ai ir įvykiai lieka vienoje
 * istorijoje su sėkmingomis bangomis.
 */
export function planWaveWithoutGraph(input: WaveWithoutGraphInput, detail: string): WavePlan {
  const tasks = normalizeSchedulableTasks(input.tasks);
  const graphHash = computeGraphHash(tasks);
  const waveSequence = Math.max(1, Math.trunc(input.waveSequence ?? 1));
  const blocked: WaveBlockedTask[] = tasks
    .map((task) => ({
      task_id: task.task_id,
      file: task.file,
      blocked_by: [...task.blocked_by],
      reason: "gate:graph-unavailable" as const,
      waiting_for: [],
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    scheduler_version: WAVE_SCHEDULER_VERSION,
    wave_id: waveIdFor(waveSequence, graphHash),
    wave_sequence: waveSequence,
    graph_hash: graphHash,
    // `unavailable` žyma daro šį atspaudą nesutampantį su JOKIU normaliu sprendimu: banga be
    // autoriteto niekada neturi atrodyti kaip banga, kurios vartai viską praleido.
    decision_hash: computeWaveDecisionHash({ waveGraphHash: graphHash, unavailable: true, ready: [], blocked }),
    max_workers: clampWaveWorkers(input.maxWorkers),
    ready: [],
    blocked,
    // Be grafo NEĮMANOMA pasakyti, kurios nuorodos yra išorinės ar ciklinės — o spėti čia
    // draudžia ta pati taisyklė, dėl kurios banga sustabdyta.
    external_dependencies: [],
    cycles: [],
    graph_unavailable_reason: detail,
  };
}

/** Kiek blokuotų task'ų vardijama vienoje priežasties eilutėje, kol pereinama į santrauką. */
const DEFAULT_BLOCKED_REASON_LIMIT = 5;

/**
 * Deterministinė „kodėl banga stovi" eilutė esamam wave event `reason` laukui.
 *
 * Formatavimo taisyklė turi būti VIENA: tą pačią eilutę mato log'as, wave event'as ir
 * operatoriaus stdout. Rūšiuojama pagal `task_id` (ne pagal failą), nes ID nesikeičia
 * task'ui persikėlus tarp bucket'ų.
 */
export function formatWaveBlockedReason(
  reason: string,
  blocked: readonly WaveBlockedTask[],
  options: { limit?: number } = {},
): string {
  if (blocked.length === 0) return reason;

  const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_BLOCKED_REASON_LIMIT));
  const entries = [...blocked].sort((a, b) => a.task_id.localeCompare(b.task_id));
  const named = entries.slice(0, limit).map((task) => {
    const waiting = task.waiting_for.length > 0 ? `<-${task.waiting_for.join("+")}` : "";
    return `${task.task_id}=${task.reason}${waiting}`;
  });
  const overflow = entries.length - named.length;

  return [reason, ...named, ...(overflow > 0 ? [`+${overflow} more`] : [])].join("; ");
}
