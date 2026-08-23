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
import { scheduleNextWave, type SchedulableTask } from "../application/scheduling/index.js";
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

test("sutampantis pasaulis: grafo kelias duoda TĄ PATĮ planą kaip senasis", () => {
  const { tasks, graph } = consistentWorld();

  // Be run'o būsenos.
  assert.deepEqual(
    scheduleNextWave({ tasks, graph, waveSequence: 2, maxWorkers: 2 }),
    scheduleNextWave({ tasks, waveSequence: 2, maxWorkers: 2 }),
    "planas privalo sutapti visas — įskaitant depth tvarką, graph_hash ir wave_id",
  );

  // Su run'o būsena: `completed` ir lūžusi šaka yra būtent tai, ką kanoninis grafas gauna per
  // statusOverrides, tad sutapimas čia yra sutapimo su `buildReadySet` prielaida.
  const run = { completedTaskIds: ["0001"], blockedTaskIds: ["0004"] } as const;
  const unified = scheduleNextWave({ tasks, graph, ...run });
  assert.deepEqual(unified, scheduleNextWave({ tasks, ...run }));
  assert.deepEqual(unified.ready.map((task) => [task.task_id, task.depth]), [["0002", 1]], "gylis skaičiuojamas per grafą");
  assert.equal(unified.blocked.find((task) => task.task_id === "0004")?.reason, "branch-blocked", "lūžusi šaka lieka MATOMA");
});

test("divergencija 1: dingusi priklausomybė nebelaikoma įvykdyta", () => {
  const tasks = [queued("0001", ["9999"])];
  const graph = buildTaskGraph({ nodes: [node("0001", "queue", { depends_on: ["9999"] })] });

  assert.deepEqual(scheduleNextWave({ tasks }).ready.map((task) => task.task_id), ["0001"], "senasis kelias VYKDYTŲ");

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

  assert.deepEqual(scheduleNextWave({ tasks }).ready.map((task) => task.task_id), ["0001"], "senasis kelias nuimdavo briauną");

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

  assert.ok(
    scheduleNextWave({ tasks, ...run }).ready.some((task) => task.task_id === "2000"),
    "senasis kelias išspręsdavo prefiksą pirmu kandidatu, o tas jau atliktas — task'as paleidžiamas",
  );

  const unified = scheduleNextWave({ tasks, graph, ...run });
  assert.deepEqual(unified.ready.map((task) => task.task_id), ["1111-b"], "`2000` laukia, kol nuoroda taps vienareikšmė");
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
