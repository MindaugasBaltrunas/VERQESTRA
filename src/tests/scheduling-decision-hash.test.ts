// 2026-08-23 (operatoriaus radinys): bangos tapatybė neatspindėjo galutinio sprendimo.
//
// `graph_hash` skaičiuojamas tik iš eilės pjūvio — ID, failų, priklausomybių. Patvirtinimai,
// mazgų statusai, biudžetas ir vartų politika į jį nepatenka, tad KELI skirtingi vykdymo planai
// gaudavo vieną `wave_id` ir vieną `graph_hash`. `recoverFromCrash` pagal tą sutapimą tęsdavo tą
// pačią bangą — t. y. po kritimo atkurtas planas galėjo remtis leidimu, kurio nebėra.
//
// Trys iš keturių įėjimų nematomi NET kanoniniam `tg` hash'ui: runtime patvirtinimai, biudžetas ir
// `enforce` gyvena iškvietėjo pusėje. Todėl atspaudas imamas nuo VERDIKTŲ, o ne nuo įėjimų sąrašo:
// kiekvienas vartas — ir esamas, ir būsimas — pasireiškia verdiktu, tad naujas įėjimas negali
// atsirasti nepatekęs į atspaudą.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/index.js";
import {
  applyReadySetGates,
  buildReadySet,
  planWaveWithoutGraph,
  scheduleNextWave,
  type ReadySetGatePolicy,
  type SchedulableTask,
} from "../application/scheduling/index.js";
import type { TaskGraphNodeInput } from "../domain/tasks/graph/model.js";

const TASKS: SchedulableTask[] = [{ task_id: "a", file: "AG/tasks/queue/a.md", blocked_by: [] }];

function nodeOf(taskId: string, extra: Partial<TaskGraphNodeInput> = {}): TaskGraphNodeInput {
  return { task_id: taskId, file: `AG/tasks/queue/${taskId}.md`, checks: ["x"], scope: [`src/${taskId}.ts`], ...extra };
}

function graphWith(extra: Partial<TaskGraphNodeInput>) {
  return buildTaskGraph({ nodes: [nodeOf("a", extra)] });
}

function decide(
  graph: ReturnType<typeof buildTaskGraph>,
  options: { approvals?: string[]; budget?: { remaining_tokens: number }; policy?: ReadySetGatePolicy } = {},
) {
  const plan = scheduleNextWave({ tasks: TASKS, graph });
  const readySet = buildReadySet({
    graph,
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  });
  return applyReadySetGates(plan, readySet, options.policy);
}

test("skirtingi vykdymo planai gauna skirtingus decision_hash — o wave_id lieka stabilus", () => {
  const open = graphWith({});
  const needsApproval = graphWith({ requires_approval: true });
  const estimated = graphWith({ estimated_tokens: 500 });

  const plans = [
    decide(open),
    decide(needsApproval),
    decide(needsApproval, { approvals: ["a"] }),
    decide(estimated, { budget: { remaining_tokens: 1000 } }),
    decide(estimated, { budget: { remaining_tokens: 10 } }),
    decide(needsApproval, { policy: { enforce: [] } }),
    planWaveWithoutGraph({ tasks: TASKS }, "importas lūžo"),
  ];

  const decisions = new Set(plans.map((plan) => plan.decision_hash));
  assert.equal(decisions.size, plans.length, "kiekvienas skirtingas sprendimas turi savo atspaudą");
  for (const hash of decisions) assert.match(hash, /^dh1:[0-9a-f]{16}$/);

  // Tapatybė TYČIA nesikeičia: `wave_id` atsako „kuri tai banga" ir laiko įvykius bei snapshot'us
  // vienoje istorijoje. Patvirtinus vieną task'ą banga neturi pasikeisti vardo.
  const waveIds = new Set(plans.map((plan) => plan.wave_id));
  assert.equal(waveIds.size, 1, "vienas eilės pjūvis — viena bangos tapatybė");

  // Būtent šitas sutapimas ir buvo spraga: du skirtingi planai, vienas `graph_hash`.
  assert.equal(plans[0]?.graph_hash, plans[1]?.graph_hash);
  assert.notEqual(plans[0]?.decision_hash, plans[1]?.decision_hash);
});

// 2026-08-23 (operatoriaus radinys): atspaudas buvo skaičiuojamas PRIEŠ galutinį surinkimą ir ėmė
// `readySet.ready`/`readySet.blocked`. Todėl į jį nepatekdavo priežastys, kurios kyla NE iš
// ready-set'o — `gate:graph-state-mismatch` gimsta palyginus `observedQueue` su grafu, o
// `branch-blocked` ateina iš run'o būsenos.
//
// Taisyta imant GALUTINĮ planą: taip joks būsimas priežasčių šaltinis iš atspaudo iškristi nebegali.
// Tai ta pati logika, dėl kurios atspaudas ima verdiktus, o ne įėjimų sąrašą — tik vienu lygmeniu
// toliau.
test("decision_hash apima priežastis, kurių ready-set'e NĖRA", () => {
  const empty = buildTaskGraph({ nodes: [] });
  const plan = (tasks: SchedulableTask[]) =>
    applyReadySetGates(scheduleNextWave({ tasks, graph: empty }), buildReadySet({ graph: empty }));

  const withoutQueue = plan([]);
  const withOrphan = plan([{ task_id: "a", file: "AG/tasks/queue/a.md", blocked_by: [] }]);

  assert.deepEqual(withoutQueue.blocked, [], "kontrolė: nieko nesustabdyta");
  assert.deepEqual(
    withOrphan.blocked.map((task) => task.reason),
    ["gate:graph-state-mismatch"],
    "eilės task'as be grafo mazgo sustabdomas",
  );
  assert.equal(withoutQueue.graph_hash, withOrphan.graph_hash, "bangos tapatybė ta pati — pjūvis abu kartus tuščias");
  assert.notEqual(
    withoutQueue.decision_hash,
    withOrphan.decision_hash,
    "skirtingi galutiniai planai NEGALI dalytis vienu sprendimo atspaudu",
  );

  // `branch-blocked` — antras šaltinis už ready-set'o ribų.
  const open = buildTaskGraph({ nodes: [nodeOf("a")] });
  const tasks = [{ task_id: "a", file: "AG/tasks/queue/a.md", blocked_by: [] }];
  const running = applyReadySetGates(scheduleNextWave({ tasks, graph: open }), buildReadySet({ graph: open }));
  const brokenBranch = applyReadySetGates(
    scheduleNextWave({ tasks, graph: open, blockedTaskIds: ["a"] }),
    buildReadySet({ graph: open }),
  );
  assert.notEqual(running.decision_hash, brokenBranch.decision_hash, "run'o būsena taip pat privalo patekti į atspaudą");
});

test("decision_hash yra deterministinis ir nepriklauso nuo verdiktų tvarkos", () => {
  const graph = graphWith({});
  assert.equal(decide(graph).decision_hash, decide(graph).decision_hash, "tas pats sprendimas — tas pats atspaudas");

  // Tas pats biudžetas kitu skaičiumi, bet TA PATI išvada: sprendimas nepasikeitė, tad ir
  // atspaudas neturi keistis. Atspaudas seka verdiktus, o ne įėjimų reikšmes.
  const estimated = graphWith({ estimated_tokens: 100 });
  assert.equal(
    decide(estimated, { budget: { remaining_tokens: 1000 } }).decision_hash,
    decide(estimated, { budget: { remaining_tokens: 5000 } }).decision_hash,
    "abu biudžetai pakankami — verdiktas tas pats",
  );
});

test("banga be grafo niekada neprilygsta bangai, kurios vartai viską praleido", () => {
  const passed = decide(graphWith({}));
  const unavailable = planWaveWithoutGraph({ tasks: TASKS }, "markdown sugadintas");

  assert.equal(passed.graph_hash, unavailable.graph_hash, "tas pats eilės pjūvis");
  assert.notEqual(passed.decision_hash, unavailable.decision_hash, "be autoriteto nėra tas pat kas viskas leista");
  assert.equal(unavailable.wave_id, passed.wave_id, "tapatybė ta pati — sustabdyta banga lieka toje pačioje istorijoje");
});
