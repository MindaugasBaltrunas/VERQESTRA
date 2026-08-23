// 2026-08-23 (operatoriaus radiniai, 2×P1 + 2×P2): priklausomybių prefiksų matcher'is buvo
// taikomas task'ų TAPATYBĖMS.
//
// `dependencyMatches` yra SIMETRIŠKAS (`0042-parent` ↔ `0042-parent-02-child` abiem kryptimis) ir
// toks turi likti — task failai blokatorių rašo tai sutrumpintai, tai pilnu vardu, tad NUORODOS
// rezoliucijai simetrija reikalinga. Bėda buvo ta, kad tuo pačiu matcher'iu buvo atsakinėjama į
// visai kitą klausimą — „ar tai tas pats task'as", — o tapatybė prefiksų neturi.
//
// Keturios pasekmės, visos su tuo pačiu tėvo/vaiko pavyzdžiu:
//   P1 užbaigus tėvą vaikas TYLIAI dingdavo iš bangos (vartai subtract-only — grąžinti nebegali);
//   P1 resume vaikui grąžindavo `skip-completed`, ir atkūrimas galėjo jį nustumti į `done`;
//   P2 normalizavimas TEISĖTĄ tėvo briauną laikydavo savęs nuoroda ir ją nuimdavo;
//   P2 blokuoto task'o maršrutizavimas į human-review paimdavo NESUSIJUSĮ task'ą.
//
// Testas dirba su vienu fixture'u visiems keturiems keliams sąmoningai: tai VIENA klaida, ir jei
// kas nors vėl sujungtų tapatybę su rezoliucija, kristų ne vienas testas, o visi keturi.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/build.js";
import { buildReadySet } from "../application/scheduling/build-ready-set.js";
import { applyReadySetGates } from "../application/scheduling/apply-ready-set-gates.js";
import {
  collectBlockedBranch,
  normalizeSchedulableTasks,
  scheduleNextWave,
} from "../application/scheduling/schedule-next-wave.js";
import { decideResume } from "../application/scheduling/resume-run.js";
import {
  routeBlockedTasksToHumanReview,
  type BucketTaskFile,
} from "../application/task-execution/task-graph-import.js";
import { dependencyMatches, isSameTask, resolveTaskReference } from "../domain/tasks/dependencies.js";
import type { TaskBucket } from "../domain/tasks/index.js";

const PARENT = "0042-parent";
const CHILD = "0042-parent-02-child";

test("rezoliucija lieka simetriška, tapatybė — ne", () => {
  // Ši simetrija yra FUNKCIJA, ne likutis: nuoroda gali būti tiek trumpesnė, tiek ilgesnė už ID.
  assert.ok(dependencyMatches(CHILD, PARENT), "nuoroda gali būti ilgesnė už mazgo ID");
  assert.ok(dependencyMatches(PARENT, CHILD), "ir trumpesnė");

  // Tapatybė — tik tikslus atitikmuo (po normalizacijos).
  assert.equal(isSameTask(PARENT, CHILD), false, "tėvas NĖRA savo vaikas");
  assert.equal(isSameTask(CHILD, PARENT), false, "vaikas NĖRA savo tėvas");
  assert.ok(isSameTask(`AG/tasks/queue/${CHILD}.md`, CHILD), "kelio forma normalizuojama");
  assert.equal(isSameTask("", ""), false, "tuščia nėra tapatybė");
});

test("rezoliucija prieš ID visatą: tikslus laimi, dviprasmybė atmetama", () => {
  const universe = [PARENT, CHILD];
  assert.equal(resolveTaskReference(universe, PARENT), PARENT, "tikslus atitikmuo nusveria prefiksą");
  assert.equal(resolveTaskReference(universe, CHILD), CHILD);
  assert.equal(resolveTaskReference([PARENT, "0099-other"], "0042"), PARENT, "vienintelis prefiksinis kandidatas");
  // Klaidingas blokuotojas ATRAKINA task'ą, kuris turėjo laukti — tad „nežinau" yra saugi pusė.
  assert.equal(resolveTaskReference(["1111-a", "1111-b"], "1111"), undefined, "dviprasmybė → undefined");
  assert.equal(
    resolveTaskReference(universe, "0042-parent-02"),
    undefined,
    "prefiksas, tinkantis IR tėvui, IR vaikui, yra dviprasmybė — ne vaikas",
  );
  assert.equal(resolveTaskReference(universe, "9999"), undefined, "nežinoma nuoroda");
});

test("P1: užbaigus tėvą vaikas lieka bangoje", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: PARENT, file: `AG/tasks/done/${PARENT}.md`, status: "done", checks: ["x"], scope: ["src/a.ts"] },
      { task_id: CHILD, file: `AG/tasks/queue/${CHILD}.md`, checks: ["x"], scope: ["src/b.ts"] },
    ],
  });
  const tasks = [{ task_id: CHILD, file: `AG/tasks/queue/${CHILD}.md`, blocked_by: [] }];

  const plan = scheduleNextWave({ tasks, graph, completedTaskIds: [PARENT] });
  const canonical = buildReadySet({ graph });
  const gated = applyReadySetGates(plan, canonical);

  assert.deepEqual(
    canonical.ready.map((entry) => entry.task_id),
    [CHILD],
    "kanoninis grafas vaiką leidžia — jis niekada nebuvo priklausomas nuo tėvo",
  );
  // Būtent čia vaikas dingdavo: bangos planas grąžindavo `ready=[] blocked=[]`, t. y. task'as
  // pradingdavo BE PĖDSAKO — net ne kaip blokuotas.
  assert.deepEqual(plan.ready.map((entry) => entry.task_id), [CHILD], "banga vaiko nepraranda");
  assert.deepEqual(plan.blocked, [], "ir jo neblokuoja");
  assert.deepEqual(gated.ready.map((entry) => entry.task_id), [CHILD], "vartai vaiko nenuima");
});

test("P1: resume neužbaigto prefiksinio vaiko nelaiko atliktu", () => {
  const decision = decideResume(
    { status: "started", task_id: CHILD, updated_at: "2026-08-23T12:00:00.000Z" },
    { location: "queue", acceptedCommit: false, completedTaskIds: [PARENT] },
  );
  assert.notEqual(decision.action, "skip-completed", "užbaigtas tėvas nėra užbaigtas vaikas");
  assert.equal(decision.action, "retry-task", "eilėje likęs vaikas saugiai kartojamas");

  // Tikras `skip-completed` privalo išlikti — kitaip testas tik įrodytų, kad šaka mirusi.
  const completed = decideResume(
    { status: "started", task_id: CHILD, updated_at: "2026-08-23T12:00:00.000Z" },
    { location: "queue", acceptedCommit: false, completedTaskIds: [CHILD] },
  );
  assert.equal(completed.action, "skip-completed", "TAS PATS task'as vis dar praleidžiamas");
});

test("P2: normalizavimas nenuima teisėtos tėvo→vaiko briaunos", () => {
  const [normalized] = normalizeSchedulableTasks([
    { task_id: CHILD, file: `AG/tasks/queue/${CHILD}.md`, blocked_by: [PARENT] },
  ]);
  assert.deepEqual(normalized?.blocked_by, [PARENT], "tėvas nėra vaiko savęs nuoroda");

  // Tikra savęs nuoroda vis dar nuimama: be jos task'as užsirakintų amžiams.
  const [selfReferencing] = normalizeSchedulableTasks([
    { task_id: CHILD, file: `AG/tasks/queue/${CHILD}.md`, blocked_by: [`AG/tasks/queue/${CHILD}.md`, PARENT] },
  ]);
  assert.deepEqual(selfReferencing?.blocked_by, [PARENT], "sava nuoroda kelio forma vis dar nuimama");

  const branch = collectBlockedBranch(
    [
      { task_id: PARENT, file: `AG/tasks/queue/${PARENT}.md`, blocked_by: [] },
      { task_id: CHILD, file: `AG/tasks/queue/${CHILD}.md`, blocked_by: [PARENT] },
    ],
    PARENT,
  );
  assert.deepEqual(branch, [PARENT, CHILD], "vaikas patenka į lūžusią tėvo šaką");
});

test("P2: lūžęs vaikas neįtraukia į šaką nuo jo nepriklausančių task'ų", () => {
  const branch = collectBlockedBranch(
    [
      { task_id: PARENT, file: `AG/tasks/queue/${PARENT}.md`, blocked_by: [] },
      { task_id: CHILD, file: `AG/tasks/queue/${CHILD}.md`, blocked_by: [PARENT] },
      { task_id: "0099-other", file: "AG/tasks/queue/0099-other.md", blocked_by: [PARENT] },
    ],
    CHILD,
  );
  assert.deepEqual(branch, [CHILD], "priklausomybė nuo TĖVO nėra priklausomybė nuo vaiko");
});

test("P2: blokuoto vaiko maršrutizavimas nepaliečia nuo tėvo priklausančio task'o", async () => {
  const queue: BucketTaskFile[] = [
    {
      file: "AG/tasks/queue/0099-other.md",
      text: `# Task\n## Tikslas\nX.\n## Dependencies\n- blocked_by: ${PARENT}\n`,
    },
    {
      file: "AG/tasks/queue/0100-real-dependent.md",
      text: `# Task\n## Tikslas\nY.\n## Dependencies\n- blocked_by: ${CHILD}\n`,
    },
  ];
  // Tėvas realiai EGZISTUOJA — jis tiesiog ne eilėje (ką tik nukeliavo į human-review). Būtent to
  // fixture'e trūko pirmame bandyme, ir taisymas atrodė nesuveikęs: rezoliucija be tėvo neturi kaip
  // atskirti „sutrumpinta vaiko nuoroda" nuo „nuoroda į tėvą", tad visata privalo apimti VISUS
  // bucket'us, ne tik `queue`.
  const humanReview: BucketTaskFile[] = [
    { file: `AG/tasks/human-review/${PARENT}.md`, text: "# Task\n## Tikslas\nTėvas.\n" },
    { file: `AG/tasks/human-review/${CHILD}.md`, text: "# Task\n## Tikslas\nVaikas.\n" },
  ];
  const ports = {
    listTasksInBucket: (bucket: TaskBucket) =>
      Promise.resolve(bucket === "queue" ? queue : bucket === "human-review" ? humanReview : []),
    readTaskText: (file: string) => Promise.resolve(queue.find((task) => task.file === file)!.text),
    writeTaskText: () => Promise.resolve(),
    moveToHumanReview: (file: string) => Promise.resolve(file.replace("/queue/", "/human-review/")),
  };

  // human-review yra TERMINALINIS bucket'as: klaidingas perkėlimas čia yra neatstatoma klaida
  // nesusijusiam task'ui, tad prefiksinis „gal tai jis" čia netinka iš principo.
  const result = await routeBlockedTasksToHumanReview(ports, CHILD);
  assert.deepEqual(
    result.routed.map((route) => route.task_id),
    ["0100-real-dependent"],
    "perkeliamas tik tas, kuris tikrai priklauso nuo vaiko",
  );

  const fromParent = await routeBlockedTasksToHumanReview(ports, PARENT);
  assert.deepEqual(
    fromParent.routed.map((route) => route.task_id),
    ["0099-other"],
    "ir atvirkščiai: tėvo lūžis nepaima vaiko priklausinio",
  );
});
