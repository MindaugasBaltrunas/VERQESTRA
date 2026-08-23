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

// Trečias tos pačios fail-open klaidos pavidalas: vartai tik ATIMDAVO `readySet.blocked`, o
// `readySet.ready` neskaitė. Task'as, kurio grafas nevardija NEI kaip leidžiamo, NEI kaip
// sustabdyto, pralįsdavo pro VISUS vartus. Realu, nes `wave-scheduler` eilę ir kanoninį grafą
// skaito atskirais FS skaitymais: tarp jų task'as spėja persikelti tarp bucket'ų.
test("kanoninis grafas yra LEIDIMŲ sąrašas: bangos ir grafo nesutapimas blokuoja", () => {
  const plan = scheduleNextWave({ tasks: [schedulable("a", "AG/tasks/queue/a.md")] });

  // A. Task'o grafe apskritai nėra.
  const absent = buildTaskGraph({
    nodes: [{ task_id: "kitas", file: "AG/tasks/queue/kitas.md", checks: ["x"], scope: ["src/**"] }],
  });
  const absentReadySet = buildReadySet({ graph: absent });
  assert.deepEqual(absentReadySet.blocked, [], "grafas apie `a` NIEKO nesako — todėl ir buvo pralaidu");
  assert.deepEqual(gatedReadyIds(plan, absent), [], "nebuvimas grafe nėra leidimas");

  // B. Grafe jau `done`. Blogesnis atvejis: užbaigtas mazgas nepatenka NĖ Į VIENĄ sąrašą
  // (jis tenkina priklausomybes), tad be sankirtos jau atliktas task'as būtų vykdomas iš naujo.
  const done = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/done/a.md", status: "done", checks: ["x"], scope: ["src/**"] }],
  });
  const doneReadySet = buildReadySet({ graph: done });
  assert.deepEqual(doneReadySet.ready, [], "užbaigto mazgo `ready` sąraše nėra");
  assert.deepEqual(doneReadySet.blocked, [], "ir `blocked` sąraše jo taip pat nėra");
  const doneGated = applyReadySetGates(plan, doneReadySet);
  assert.deepEqual(doneGated.ready, [], "jau atliktas task'as NEvykdomas iš naujo");
  assert.equal(doneGated.blocked[0]?.reason, "gate:graph-state-mismatch", "atskira, įvardyta priežastis");

  // C. Susiaurintas `enforce` gali išjungti grafo VERDIKTĄ, bet ne autoriteto trūkumą.
  assert.deepEqual(
    applyReadySetGates(plan, absentReadySet, { enforce: [] }).ready,
    [],
    "nesutapimas nėra politikos klausimas",
  );

  // D. Kontrolė: sutampanti būsena praeina, ir SUBTRACT-ONLY tapatybė išlieka.
  const queued = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", checks: ["x"], scope: ["src/**"] }],
  });
  assert.equal(applyReadySetGates(plan, buildReadySet({ graph: queued })), plan, "sutampant — TAS PATS objektas");
});

// Paskutinis nesutarimas tarp dviejų grafo skaitytojų: DVIPRASMIŠKAS PREFIKSAS. Kanoninis jį
// atmeta (`resolveTaskNode` grąžina undefined, kai kandidatų daugiau nei vienas), bangos
// planuoklis ima PIRMĄ kandidatą. Kol vienas iš kandidatų nebaigtas, abi pusės fail-closed ir
// skirtumas nematomas; kai baigtas — pusės išsiskiria priešingomis kryptimis. Šis testas laiko
// būtent tą tašką, nes jis vienintelis rodo skirtumą kaip VYKDYMO, o ne formuluotės klausimą.
test("dviprasmiškas prefiksas: banga paleistų, kanoninis grafas sustabdo", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "1111-a", file: "AG/tasks/done/1111-a.md", status: "done", checks: ["x"], scope: ["src/a.ts"] },
      { task_id: "1111-b", file: "AG/tasks/queue/1111-b.md", checks: ["x"], scope: ["src/b.ts"] },
      { task_id: "2000", file: "AG/tasks/queue/2000.md", depends_on: ["1111"], checks: ["x"], scope: ["src/c.ts"] },
    ],
  });

  // Eilė mato TIK queue bucket'ą, tad `1111-a` jai ateina kaip „completed".
  const plan = scheduleNextWave({
    tasks: [schedulable("1111-b", "AG/tasks/queue/1111-b.md"), schedulable("2000", "AG/tasks/queue/2000.md", ["1111"])],
    completedTaskIds: ["1111-a"],
  });
  assert.ok(
    plan.ready.some((task) => task.task_id === "2000"),
    "planuoklis `1111` išsprendžia pirmu kandidatu ir laiko jį atliktu",
  );

  const readySet = buildReadySet({ graph });
  assert.equal(
    readySet.blocked.find((entry) => entry.task_id === "2000")?.reason,
    "missing-dependency",
    "kanoninis atsisako spėti, kuris `1111-*` turėtas omenyje",
  );

  const gated = applyReadySetGates(plan, readySet);
  assert.deepEqual(
    gated.ready.map((task) => task.task_id),
    ["1111-b"],
    "sprendžia kanoninis: `2000` nevykdomas, kol nuoroda dviprasmiška",
  );
  assert.equal(gated.blocked.find((task) => task.task_id === "2000")?.reason, "gate:missing-dependency");
});
