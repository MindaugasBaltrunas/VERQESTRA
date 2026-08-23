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

function graphWith(extra: Partial<TaskGraphNodeInput>) {
  return buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", checks: ["x"], scope: ["src/a.ts"], ...extra }],
  });
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
