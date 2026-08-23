// 2026-08-23 auditas: kanoninis DAG NEBUVO produkcinis vykdymo autoritetas.
//
// `buildReadySet` verdiktus skaičiavo teisingai, bet numatytoji vartų politika apėmė TIK biudžeto
// priežastis, o `readySetPolicy` produkcinis wiring'as niekada nepadavė (nei VERQESTRA, nei
// etalone). Rezultatas: `graph-invalid`, `missing-dependency`, `dependency-cycle`,
// `invalid-terminal-dependency` ir `approval-required` buvo apskaičiuojami ir IŠMETAMI, o
// paskutinį žodį turėjo SĄMONINGAI ATLAIDUS bangos planuoklis (savęs nuoroda nuimama, eilėje
// nesantis blokatorius laikomas įvykdytu, dviprasmiškas prefiksas sprendžiamas pirmu kandidatu).
//
// Šie testai pin'ina atstatytą ribą: `scheduleNextWave` atsako „kokia TVARKA", o kanoninis grafas —
// „ar apskritai LEIDŽIAMA". Atskiras failas nuo `scheduling-waves`, nes tai kito lygmens klausimas
// (autoritetas, ne planavimo determinizmas) ir dėl 500 eilučių vartų.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/index.js";
import {
  applyReadySetGates,
  blockWaveWithoutGraph,
  buildReadySet,
  scheduleNextWave,
  type SchedulableTask,
} from "../application/scheduling/index.js";

function schedulable(taskId: string, file: string, blockedBy: readonly string[] = []): SchedulableTask {
  return { task_id: taskId, file, blocked_by: blockedBy };
}

function gatedReadyIds(
  plan: ReturnType<typeof scheduleNextWave>,
  graph: Parameters<typeof buildReadySet>[0]["graph"],
): string[] {
  return applyReadySetGates(plan, buildReadySet({ graph })).ready.map((task) => task.task_id);
}

test("kanoninis grafas NUGALI atlaidų bangos planuoklį: nesama priklausomybė, self-edge, ciklas per human-review", () => {
  // A. Priklausomybė į task'ą, kurio grafe NĖRA. Planuokliui jis „external", t. y. įvykdytas.
  const missing = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["nera-tokio"], checks: ["x"], scope: ["src/**"] }],
  });
  const missingPlan = scheduleNextWave({ tasks: [schedulable("a", "AG/tasks/queue/a.md", ["nera-tokio"])] });
  assert.deepEqual(missingPlan.ready.map((task) => task.task_id), ["a"], "planuoklis vienas paleistų");
  assert.deepEqual(gatedReadyIds(missingPlan, missing), [], "grafas: missing-dependency");

  // B. `a → a`. Planuoklis savęs nuorodą NUIMA, tad task'as lieka be priklausomybių.
  const selfEdge = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["a"], checks: ["x"], scope: ["src/**"] }],
  });
  const selfPlan = scheduleNextWave({ tasks: [schedulable("a", "AG/tasks/queue/a.md", ["a"])] });
  assert.deepEqual(selfPlan.ready.map((task) => task.task_id), ["a"], "planuoklis vienas paleistų");
  assert.equal(buildReadySet({ graph: selfEdge }).executable, false, "grafas: ciklas");
  assert.deepEqual(gatedReadyIds(selfPlan, selfEdge), [], "graph-invalid sustabdo VISKĄ");

  // C. `a(queue) → b(human-review) → a`. Banga mato tik queue, tad `b` jai „external".
  const crossBucketCycle = buildTaskGraph({
    nodes: [
      { task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["b"], checks: ["x"], scope: ["src/**"] },
      {
        task_id: "b",
        file: "AG/tasks/human-review/b.md",
        status: "human-review",
        depends_on: ["a"],
        checks: ["x"],
        scope: ["src/**"],
      },
    ],
  });
  const cyclePlan = scheduleNextWave({ tasks: [schedulable("a", "AG/tasks/queue/a.md", ["b"])] });
  assert.deepEqual(cyclePlan.ready.map((task) => task.task_id), ["a"], "planuoklis vienas paleistų");
  assert.deepEqual(gatedReadyIds(cyclePlan, crossBucketCycle), [], "graph-invalid sustabdo VISKĄ");
});

test("numatytieji vartai gina ir žmogaus patvirtinimą (approval-required)", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "a", file: "AG/tasks/queue/a.md", checks: ["x"], scope: ["src/**"], requires_approval: true },
      { task_id: "b", file: "AG/tasks/queue/b.md", checks: ["x"], scope: ["src/**"] },
    ],
  });
  const plan = scheduleNextWave({
    tasks: [schedulable("a", "AG/tasks/queue/a.md"), schedulable("b", "AG/tasks/queue/b.md")],
  });
  const gated = applyReadySetGates(plan, buildReadySet({ graph }));

  assert.deepEqual(gated.ready.map((task) => task.task_id), ["b"], "nepatvirtintas task'as nebevykdomas");
  assert.equal(
    gated.blocked.find((task) => task.task_id === "a")?.reason,
    "gate:approval-required",
    "priežastis įvardyta, o ne nutylėta",
  );
});

test("neperskaitytas grafas SUSTABDO bangą, o ne atidaro ją be vartų", () => {
  const plan = scheduleNextWave({
    tasks: [schedulable("a", "AG/tasks/queue/a.md"), schedulable("b", "AG/tasks/queue/b.md")],
  });
  const blocked = blockWaveWithoutGraph(plan, "markdown sugadintas");

  assert.deepEqual(blocked.ready, [], "be autoriteto neįrodomas NĖ VIENO task'o leidimas");
  assert.deepEqual(
    blocked.blocked.map((task) => task.reason),
    ["gate:graph-unavailable", "gate:graph-unavailable"],
    'atskira priežastis: grafas nieko nepasakė, o ne pasakė "ne"',
  );
  assert.equal(blocked.graph_unavailable_reason, "markdown sugadintas");
  assert.equal(blocked.wave_id, plan.wave_id, "bangos tapatybė nekinta");
  // SUBTRACT-ONLY galioja ir čia: tuščias ready set reiškia, kad šalinti nėra ko.
  const empty = scheduleNextWave({ tasks: [] });
  assert.equal(blockWaveWithoutGraph(empty, "x"), empty, "nesant ko šalinti — TAS PATS objektas");
});
