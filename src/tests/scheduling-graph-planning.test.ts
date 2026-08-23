// 2026-08-23 suvienodinimas (1/3 ir 2/3): bangos planuoklis vartoja KANONINĮ grafą.
//
// Iki šiol sistemoje veikė du pilni DAG varikliai, kurių semantika skyrėsi keturiose vietose.
// Skirtumus dengė vartai, bet dvi tiesos tam pačiam klausimui yra vieta, kur trečias kvietėjas
// pasirenka neteisingą. Šis failas prikala perėjimą, ir svarbiausias jo testas yra PIRMAS:
// sutampančiam pasauliui abu keliai privalo duoti tą patį planą BAITAS Į BAITĄ. Be to įrodymo
// „naujas kelias" būtų tik antra nauja semantika, o ne perkėlimas.
//
// Likę testai fiksuoja tris sąmoningas divergencijas — visos vienos formos: tylus taisymas
// virsta matomu sustojimu.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/index.js";
import { queueSliceFromGraph, scheduleNextWave, type SchedulableTask } from "../application/scheduling/index.js";
import type { TaskGraphNodeInput } from "../domain/tasks/graph/model.js";

function node(taskId: string, bucket: string, extra: Partial<TaskGraphNodeInput> = {}): TaskGraphNodeInput {
  return { task_id: taskId, file: `AG/tasks/${bucket}/${taskId}.md`, checks: ["pnpm test"], scope: [`src/${taskId}.ts`], ...extra };
}

function queued(taskId: string, blockedBy: readonly string[] = []): SchedulableTask {
  return { task_id: taskId, file: `AG/tasks/queue/${taskId}.md`, blocked_by: blockedBy };
}

/** Grandinė 0001 → 0002 → 0003 plius nepriklausomas 0004; eilė ir grafas SUTAMPA. */
function consistentWorld(): { tasks: SchedulableTask[]; graph: ReturnType<typeof buildTaskGraph> } {
  return {
    tasks: [queued("0001"), queued("0002", ["0001"]), queued("0003", ["0002"]), queued("0004")],
    graph: buildTaskGraph({
      nodes: [
        node("0001", "queue"),
        node("0002", "queue", { depends_on: ["0001"] }),
        node("0003", "queue", { depends_on: ["0002"] }),
        node("0004", "queue"),
      ],
    }),
  };
}

// CHARACTERIZATION. Perėjimo metu (1/3, 2/3) šis testas buvo PALYGINIMAS: tas pats task sąrašas
// per abu variklius privalėjo duoti identišką planą, ir būtent tai įrodė, kad tai perkėlimas, o ne
// antra nauja semantika. 3/3 žingsnyje atlaidus variklis ištrintas, tad palyginti nebėra su kuo —
// todėl to palyginimo REZULTATAS užrašytas reikšmėmis. Įrodymas neišnyksta kartu su antrąja puse.
//
// Vienintelis sąmoningai pakitęs laukas — `graph_hash` prefiksas: `WAVE_SCHEDULER_VERSION` pakeltas
// į 2 būtent tam, kad seni snapshot'ai taptų stale.
test("sutampantis pasaulis: planas toks pat, koks buvo iki suvienodinimo", () => {
  const { tasks, graph } = consistentWorld();

  const plan = scheduleNextWave({ tasks, graph, waveSequence: 2, maxWorkers: 2 });
  assert.deepEqual(plan.ready.map((task) => [task.task_id, task.depth]), [["0001", 0], ["0004", 0]]);
  assert.deepEqual(plan.blocked.map((task) => [task.task_id, task.reason, task.waiting_for]), [
    ["0002", "unsatisfied-dependency", ["0001"]],
    ["0003", "unsatisfied-dependency", ["0002"]],
  ]);
  assert.deepEqual(plan.cycles, []);
  assert.deepEqual(plan.external_dependencies, []);
  assert.equal(plan.wave_sequence, 2);
  assert.equal(plan.max_workers, 2);
  assert.match(plan.graph_hash, /^wg2:[0-9a-f]{16}$/);
  assert.equal(plan.wave_id, `w2-${plan.graph_hash.split(":")[1]}`);

  // Su run'o būsena: `completed` ir lūžusi šaka yra būtent tai, ką kanoninis grafas gauna per
  // statusOverrides, tad šis atvejis yra sutapimo su `buildReadySet` prielaida.
  const withRun = scheduleNextWave({ tasks, graph, completedTaskIds: ["0001"], blockedTaskIds: ["0004"] });
  assert.deepEqual(withRun.ready.map((task) => [task.task_id, task.depth]), [["0002", 1]], "gylis skaičiuojamas per grafą");
  assert.deepEqual(withRun.blocked.map((task) => [task.task_id, task.reason]), [
    ["0003", "unsatisfied-dependency"],
    ["0004", "branch-blocked"],
  ]);
});

test("prefiksinės nuorodos: `waiting_for` lieka žalia nuoroda", () => {
  // Realūs task failai nurodo blokatorių numeriu (`depends_on: 004`), o ne pilnu slug'u. Pirmoji
  // perėjimo versija į `waiting_for` rašė IŠSPRĘSTĄ pilną ID, ir ekvivalencija tyliai lūžo —
  // fixture'ai su tiksliai sutampančiais ID to nerodė, o gyvas repo parodė iškart. Forma turi
  // sutapti su `buildReadySet`, nes abu sąrašai susitinka viename `blocked` per vartus.
  const tasks = [queued("004-profile"), queued("005-contract", ["004"])];
  const graph = buildTaskGraph({
    nodes: [node("004-profile", "queue"), node("005-contract", "queue", { depends_on: ["004"] })],
  });

  const plan = scheduleNextWave({ tasks, graph });
  assert.deepEqual(plan.ready.map((task) => task.task_id), ["004-profile"]);
  assert.deepEqual(
    plan.blocked.map((task) => [task.task_id, task.waiting_for]),
    [["005-contract", ["004"]]],
    "laukiama tai, ką parašė autorius — ne tai, į ką tai išsisprendė",
  );
});

test("divergencija 1: dingusi priklausomybė nebelaikoma įvykdyta", () => {
  const tasks = [queued("0001", ["9999"])];
  const graph = buildTaskGraph({ nodes: [node("0001", "queue", { depends_on: ["9999"] })] });

  // Iki suvienodinimo: `0001` buvo READY — nuorodos atitikmens eilėje nėra, tad ji buvo laikoma
  // įvykdyta „už bangos ribų".
  const unified = scheduleNextWave({ tasks, graph });
  assert.deepEqual(unified.ready, [], "leidimo įrodyti negalime, tad nevykdoma");
  assert.deepEqual(unified.blocked.map((task) => [task.task_id, task.reason, task.waiting_for]), [
    ["0001", "unsatisfied-dependency", ["9999"]],
  ]);
  // Sprendimas: laukas IŠLAIKOMAS ir gauna `missing` reikšmes — operatorius nepraranda
  // diagnostikos, o persistuojama snapshot schema nesikeičia.
  assert.deepEqual(unified.external_dependencies, ["9999"]);
});

test("divergencija 2: savęs nuoroda lieka ciklu, o ne tyliai nuimama", () => {
  const tasks = [queued("0001", ["0001"])];
  const graph = buildTaskGraph({ nodes: [node("0001", "queue", { depends_on: ["0001"] })] });

  // Iki suvienodinimo: `normalizeSchedulableTasks` savęs nuorodą NUIMDAVO, tad `0001` likdavo be
  // priklausomybių ir būdavo READY.
  const unified = scheduleNextWave({ tasks, graph });
  assert.deepEqual(unified.ready, []);
  assert.equal(unified.blocked[0]?.reason, "dependency-cycle");
  assert.deepEqual(unified.cycles, [["0001"]], "ciklas įvardijamas, o ne pataisomas");
});

test("divergencija 3: dviprasmiškas prefiksas atmetamas, o ne sprendžiamas pirmu kandidatu", () => {
  // `1111` tinka ir `1111-a` (jau atliktam), ir `1111-b` (dar eilėje).
  const tasks = [queued("1111-b"), queued("2000", ["1111"])];
  const graph = buildTaskGraph({
    nodes: [node("1111-a", "done", { status: "done" }), node("1111-b", "queue"), node("2000", "queue", { depends_on: ["1111"] })],
  });
  const run = { completedTaskIds: ["1111-a"] } as const;

  // Iki suvienodinimo: prefiksas būdavo išsprendžiamas PIRMU kandidatu, o tas jau atliktas —
  // tad `2000` būdavo paleidžiamas. Tai buvo aštriausias iš keturių skirtumų, nes vienintelis
  // rodė skirtumą kaip VYKDYMO, o ne formuluotės klausimą.

  const unified = scheduleNextWave({ tasks, graph, ...run });
  assert.deepEqual(unified.ready.map((task) => task.task_id), ["1111-b"], "`2000` laukia, kol nuoroda taps vienareikšmė");
});

// 2026-08-23 (operatoriaus radinys): bangos tapatybė buvo skaičiuojama iš EILĖS skaitymo, nors
// kandidatai jau imami iš grafo. `tasks=[]` su `graph=[a queued]` duodavo tuščios eilės hash'ą
// planui, kuriame `a` vykdomas — o du atskiri FS pjūviai skirtingu metu tai daro reguliariai
// pasiekiamu, ne teoriniu. Kanoninis grafas užduotį autorizuoja, tad fail-open spragos čia nebuvo;
// klaidinga buvo TAPATYBĖ, kuria remiasi snapshot'ai, įvykiai ir operatoriaus akis.
test("bangos tapatybė seka KANDIDATUS, o ne eilės skaitymą", () => {
  const graph = buildTaskGraph({ nodes: [node("a", "queue")] });
  const agreeing = scheduleNextWave({ tasks: [queued("a")], graph });
  const drifted = scheduleNextWave({ tasks: [], graph });

  assert.deepEqual(drifted.ready.map((task) => task.task_id), ["a"], "grafas užduotį autorizuoja");
  assert.equal(drifted.graph_hash, agreeing.graph_hash, "tas pats kandidatų rinkinys — ta pati tapatybė");
  assert.equal(drifted.wave_id, agreeing.wave_id);

  // Kontrolė: tapatybė vis dar JAUTRI kandidatų aibei — kitaip ji būtų konstanta, o ne atspaudas.
  const wider = scheduleNextWave({ tasks: [], graph: buildTaskGraph({ nodes: [node("a", "queue"), node("b", "queue")] }) });
  assert.notEqual(wider.graph_hash, agreeing.graph_hash);
});

test("queueSliceFromGraph duoda tą patį pjūvį, kurį planuoja banga", () => {
  const graph = buildTaskGraph({
    nodes: [node("a", "queue"), node("b", "queue", { depends_on: ["a"] }), node("c", "done", { status: "done" })],
  });

  // Planuoklio kandidatai ir `wave-scheduler` būsena privalo ateiti iš VIENOS funkcijos: dvi
  // vietos, savarankiškai skaičiuojančios „kas eilėje", jau kartą išsiskyrė.
  assert.deepEqual(
    queueSliceFromGraph(graph).map((task) => [task.task_id, task.blocked_by]),
    [["a", []], ["b", ["a"]]],
    "`done` mazgas į pjūvį nepatenka, o priklausomybės ateina iš grafo briaunų",
  );
  const plan = scheduleNextWave({ tasks: queueSliceFromGraph(graph), graph });
  assert.equal(plan.graph_hash, scheduleNextWave({ tasks: [], graph }).graph_hash, "pjūvis ir tapatybė sutaria");
});

test("eilėje yra, grafe ne `queued`: įvardijama, o ne tyliai iškrenta iš plano", () => {
  const tasks = [queued("0001"), queued("0002")];
  const graph = buildTaskGraph({ nodes: [node("0001", "queue"), node("0002", "done", { status: "done" })] });

  const unified = scheduleNextWave({ tasks, graph });
  assert.deepEqual(unified.ready.map((task) => task.task_id), ["0001"]);
  // Perėjus prie grafo pjūvio, eilės task'as be `queued` mazgo būtų tiesiog dingęs iš plano —
  // vienas fail-open kelias būtų pakeistas kitu, NEMATOMU. Todėl jis įvardijamas.
  assert.equal(unified.blocked.find((task) => task.task_id === "0002")?.reason, "gate:graph-state-mismatch");
});
