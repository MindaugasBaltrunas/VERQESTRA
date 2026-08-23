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
  planWaveWithoutGraph,
  buildReadySet,
  scheduleNextWave,
  type SchedulableTask,
} from "../application/scheduling/index.js";
import { wavePlanInput } from "./helpers/wave-graph-fixture.js";

function schedulable(taskId: string, file: string, blockedBy: readonly string[] = []): SchedulableTask {
  return { task_id: taskId, file, blocked_by: blockedBy };
}

function gatedReadyIds(
  plan: ReturnType<typeof scheduleNextWave>,
  graph: Parameters<typeof buildReadySet>[0]["graph"],
): string[] {
  return applyReadySetGates(plan, buildReadySet({ graph })).ready.map((task) => task.task_id);
}

// PERRAŠYTAS 2026-08-23 (suvienodinimas 3/3). Iki tol trys scenarijai rodė, kad atlaidus
// planuoklis PALEISTŲ tai, ką kanoninis grafas draudžia, ir vartai buvo VIENINTELĖ vieta, kur
// skirtumas užsidarydavo. Antro variklio nebėra, tad tas pats scenarijų rinkinys dabar tikrina
// stipresnį teiginį: planuoklis pats atsisako, O vartai su juo sutaria. Scenarijai palikti tie
// patys sąmoningai — jie yra istorinis įrodymas, kurios būtent spragos buvo uždarytos.
test("planuoklis PATS sustoja: nesama priklausomybė, self-edge, ciklas per human-review", () => {
  const planFor = (graph: ReturnType<typeof buildTaskGraph>, dependsOn: readonly string[]) =>
    scheduleNextWave({ tasks: [schedulable("a", "AG/tasks/queue/a.md", dependsOn)], graph });

  // A. Priklausomybė į task'ą, kurio grafe NĖRA. Anksčiau planuokliui jis buvo „external",
  // t. y. įvykdytas.
  const missing = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["nera-tokio"], checks: ["x"], scope: ["src/**"] }],
  });
  const missingPlan = planFor(missing, ["nera-tokio"]);
  assert.deepEqual(missingPlan.ready, [], "planuoklis pats nebelaiko dingusios priklausomybės įvykdyta");
  assert.deepEqual(gatedReadyIds(missingPlan, missing), [], "vartai sutaria");

  // B. `a → a`. Anksčiau planuoklis savęs nuorodą NUIMDAVO, tad task'as likdavo be priklausomybių.
  const selfEdge = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["a"], checks: ["x"], scope: ["src/**"] }],
  });
  const selfPlan = planFor(selfEdge, ["a"]);
  assert.deepEqual(selfPlan.ready, [], "savęs nuoroda lieka ciklu");
  assert.deepEqual(selfPlan.cycles, [["a"]], "ciklas įvardijamas plane");
  assert.equal(buildReadySet({ graph: selfEdge }).executable, false, "grafas: ciklas");
  assert.deepEqual(gatedReadyIds(selfPlan, selfEdge), [], "graph-invalid sustabdo VISKĄ");

  // C. `a(queue) → b(human-review) → a`. Anksčiau banga matė tik queue, tad `b` jai buvo
  // „external" — ciklas per kitą bucket'ą jai buvo NEMATOMAS.
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
  const cyclePlan = planFor(crossBucketCycle, ["b"]);
  assert.deepEqual(cyclePlan.ready, [], "ciklas per kitą bucket'ą dabar MATOMAS ir bangai");
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
    graph,
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
  const tasks = [schedulable("a", "AG/tasks/queue/a.md"), schedulable("b", "AG/tasks/queue/b.md")];
  // Nuo 3/3 žingsnio tai KONSTRUKTORIUS: be grafo `scheduleNextWave` neegzistuoja, tad plano,
  // kurį būtų galima apkarpyti, šioje šakoje nėra iš viso.
  const blocked = planWaveWithoutGraph({ tasks }, "markdown sugadintas");

  assert.deepEqual(blocked.ready, [], "be autoriteto neįrodomas NĖ VIENO task'o leidimas");
  assert.deepEqual(
    blocked.blocked.map((task) => task.reason),
    ["gate:graph-unavailable", "gate:graph-unavailable"],
    'atskira priežastis: grafas nieko nepasakė, o ne pasakė "ne"',
  );
  assert.equal(blocked.graph_unavailable_reason, "markdown sugadintas");
  // Bangos tapatybė skaičiuojama iš to paties eilės pjūvio, tad sustabdyta banga lieka vienoje
  // istorijoje su sėkmingomis — snapshot'ai ir įvykiai nesusimaišo.
  assert.equal(
    blocked.wave_id,
    scheduleNextWave(wavePlanInput({ tasks })).wave_id,
    "tas pats eilės pjūvis duoda tą pačią bangos tapatybę",
  );
  // Tuščia eilė: sustabdyti nėra ko, bet planas vis tiek turi būti tvarkingas.
  const empty = planWaveWithoutGraph({ tasks: [] }, "x");
  assert.deepEqual(empty.ready, []);
  assert.deepEqual(empty.blocked, []);
  assert.equal(empty.graph_unavailable_reason, "x");
});

// Trečias tos pačios fail-open klaidos pavidalas: vartai tik ATIMDAVO `readySet.blocked`, o
// `readySet.ready` neskaitė. Task'as, kurio grafas nevardija NEI kaip leidžiamo, NEI kaip
// sustabdyto, pralįsdavo pro VISUS vartus. Realu, nes `wave-scheduler` eilę ir kanoninį grafą
// skaito atskirais FS skaitymais: tarp jų task'as spėja persikelti tarp bucket'ų.
test("kanoninis grafas yra LEIDIMŲ sąrašas: bangos ir grafo nesutapimas blokuoja", () => {
  // Planas statomas su SAVAIME SUDERINTU grafu; žemiau jam taikomi ready set'ai iš SKIRTINGŲ,
  // tyčia nesutampančių grafų — būtent tai ir yra šio testo objektas.
  const plan = scheduleNextWave(wavePlanInput({ tasks: [schedulable("a", "AG/tasks/queue/a.md")] }));

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

  // D. Kontrolė: sutampanti būsena praeina, ir SUBTRACT-ONLY galioja (tikrinama turiniu —
  // `decision_hash` stampuojamas visada, nes praleidimas taip pat yra sprendimas).
  const queued = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", checks: ["x"], scope: ["src/**"] }],
  });
  assert.deepEqual(applyReadySetGates(plan, buildReadySet({ graph: queued })).ready, plan.ready, "sutampant — praleidžiama");
});

// 2026-08-23 (operatoriaus radinys): vartai lietė TIK `plan.ready`, tad task'as, kurį sustabdė ABI
// pusės, plane likdavo su bendresne bangos priežastimi. Vykdymas buvo saugus, bet operatoriaus
// pranešimai ir automatika, skaitanti priežasties kodą, gaudavo mažiau tikslų atsakymą.
//
// Prioriteto taisyklė NĖRA „kanoninis visada laimi" — laimi TIKSLESNIS, o tikslumo kryptis
// priklauso nuo to, kuris sluoksnis apskritai gali tą faktą pasakyti.
test("blokavimo priežastys suderinamos: laimi tikslesnė, o ne pirmoji", () => {
  const blockedReason = (graph: ReturnType<typeof buildTaskGraph>, tasks: SchedulableTask[], taskId: string, run = {}) => {
    const plan = scheduleNextWave({ tasks, graph, ...run });
    const gated = applyReadySetGates(plan, buildReadySet({ graph }));
    return {
      wave: plan.blocked.find((task) => task.task_id === taskId)?.reason,
      final: gated.blocked.find((task) => task.task_id === taskId)?.reason,
    };
  };

  // A. Dingusi priklausomybė: banga žino tik „laukia", grafas — KO laukia.
  const missing = buildTaskGraph({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["nera-tokio"], checks: ["x"], scope: ["src/**"] }],
  });
  const missingCase = blockedReason(missing, [schedulable("a", "AG/tasks/queue/a.md", ["nera-tokio"])], "a");
  assert.equal(missingCase.wave, "unsatisfied-dependency");
  assert.equal(missingCase.final, "gate:missing-dependency", "kanoninis tikslesnis — jis ir lieka");

  // B. Terminalinė nepatenkinama priklausomybė: `failed` blokatorius NIEKADA netenkins.
  const terminal = buildTaskGraph({
    nodes: [
      { task_id: "a", file: "AG/tasks/queue/a.md", depends_on: ["b"], checks: ["x"], scope: ["src/a.ts"] },
      { task_id: "b", file: "AG/tasks/failed/b.md", status: "failed", checks: ["x"], scope: ["src/b.ts"] },
    ],
  });
  const terminalCase = blockedReason(terminal, [schedulable("a", "AG/tasks/queue/a.md", ["b"])], "a");
  assert.equal(terminalCase.final, "gate:invalid-terminal-dependency", "NIEKADA yra kita žinia nei DAR NE");

  // C. `branch-blocked` yra ŠIO RUN'O faktas. Grafas jį mato tik kaip `not-queued` — griežtai
  // mažiau informatyvu, tad bangos priežastis privalo išlikti.
  const open = buildTaskGraph({ nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md", checks: ["x"], scope: ["src/**"] }] });
  const branchCase = blockedReason(open, [schedulable("a", "AG/tasks/queue/a.md")], "a", { blockedTaskIds: ["a"] });
  assert.equal(branchCase.final, "branch-blocked", "run'o būsenos grafas pagerinti negali");

  // D. Kai abi pusės sako TĄ PATĮ, `gate:` prefiksas nepridedamas: jis reiškia „grafas pasakė tai,
  // ko banga nežinojo", ir klijuojamas visur nustotų ką nors reikšti.
  const chain = buildTaskGraph({
    nodes: [
      { task_id: "a", file: "AG/tasks/queue/a.md", checks: ["x"], scope: ["src/a.ts"] },
      { task_id: "b", file: "AG/tasks/queue/b.md", depends_on: ["a"], checks: ["x"], scope: ["src/b.ts"] },
    ],
  });
  const sameCase = blockedReason(
    chain,
    [schedulable("a", "AG/tasks/queue/a.md"), schedulable("b", "AG/tasks/queue/b.md", ["a"])],
    "b",
  );
  assert.equal(sameCase.wave, "unsatisfied-dependency");
  assert.equal(sameCase.final, "unsatisfied-dependency", "tas pats faktas — tas pats vardas");
});

// PERRAŠYTAS 2026-08-23 (suvienodinimas 3/3). Iki tol šis testas rodė, kad dėl dviprasmiško
// prefikso du varikliai išsiskiria priešingomis kryptimis: banga imdavo pirmą kandidatą (o tas
// jau atliktas, tad task'ą PALEISDAVO), o kanoninis atsisakydavo spėti. Antro variklio nebėra,
// tad nebėra ir ko lyginti — bet klausimas lieka vertingas kita forma: ar abu sluoksniai dabar
// sako TĄ PATĮ. Sutapimas čia yra vartų prasmės sąlyga: jie turi būti antras įrodymas, o ne
// vienintelis.
test("dviprasmiškas prefiksas: planuoklis ir vartai duoda tą patį verdiktą", () => {
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
    graph,
  });
  assert.deepEqual(
    plan.ready.map((task) => task.task_id),
    ["1111-b"],
    "planuoklis PATS atsisako spėti, kuris `1111-*` turėtas omenyje",
  );
  assert.equal(plan.blocked.find((task) => task.task_id === "2000")?.reason, "unsatisfied-dependency");

  const readySet = buildReadySet({ graph });
  assert.equal(
    readySet.blocked.find((entry) => entry.task_id === "2000")?.reason,
    "missing-dependency",
    "kanoninis verdiktas tas pats, tik tikslesniu vardu",
  );

  // Vartai nieko nebeturi ŠALINTI — abi pusės jau sutaria dėl verdikto. Bet nuo 2026-08-23 jie
  // dar ir SUDERINA priežastį: bangos bendrinis `unsatisfied-dependency` pakeičiamas tikslesniu
  // kanoniniu `gate:missing-dependency`, nes automatika, skaitanti priežasties kodą, turi gauti
  // tikslų atsakymą, o ne pirmą pasitaikiusį.
  const gated = applyReadySetGates(plan, readySet);
  assert.deepEqual(gated.ready, plan.ready, "sluoksniai sutaria — šalinti nėra ko");
  assert.equal(
    gated.blocked.find((task) => task.task_id === "2000")?.reason,
    "gate:missing-dependency",
    "galutiniame plane lieka TIKSLESNĖ priežastis",
  );
});
