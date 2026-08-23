// VQ-303 (1 dalis): scheduling bangų logikos unit testai — wave scheduler determinizmas ir
// blokavimo taisyklės, kanoninio grafo ready set vartų tvarka, subtract-only grafo vartai
// virš bangos plano, resume sprendimo taisyklių tvarka, nepriklausomumo detektorius.
// Domain grynųjų taisyklių characterization parity gyvena characterization-scheduling teste.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/index.js";
import {
  applyReadySetGates,
  buildReadySet,
  clampWaveWorkers,
  collectBlockedBranch,
  computeGraphHash,
  decideResume,
  formatWaveBlockedReason,
  normalizeSchedulableTasks,
  WAVE_SCHEDULER_VERSION,
  scheduleNextWave,
  selectNextWaveTask,
  WAVE_MAX_WORKERS,
  WAVE_WORKER_HARD_CAP,
  type SchedulableTask,
  type ResumeEvidence,
} from "../application/scheduling/index.js";
import { wavePlanInput } from "./helpers/wave-graph-fixture.js";

function schedulable(taskId: string, file: string, blockedBy: readonly string[] = []): SchedulableTask {
  return { task_id: taskId, file, blocked_by: blockedBy };
}

// ---------------------------------------------------------------------------
// scheduleNextWave
// ---------------------------------------------------------------------------

// PASTABA (2026-08-23 auditas): šis testas pin'ina ATLAIDŲ bangos planuoklio normalizavimą —
// savęs nuoroda nuimama, dublikatui paliekamas pirmas failas. Tai NĖRA leidimo taisyklė ir nuo
// audito nebeturi paskutinio žodžio: kanoninis grafas tuos pačius atvejus vadina ciklu bei
// dublikatu ir juos sustabdo (žr. „kanoninis grafas NUGALI atlaidų bangos planuoklį" žemiau).
test("normalizeSchedulableTasks drops placeholders, self-references and duplicates", () => {
  const tasks = normalizeSchedulableTasks([
    schedulable("0002", "AG/tasks/queue/0002-b.md", ["none", "TBD", "-", "0001", "0002"]),
    schedulable("0001", "AG/tasks/queue/0001-a.md"),
    schedulable("0001", "AG/tasks/queue/0001-duplicate.md"),
  ]);

  assert.deepEqual(
    tasks.map((task) => task.task_id),
    ["0001", "0002"],
    "sorted by file, duplicate id dropped (first by file order wins)",
  );
  assert.equal(tasks[0]?.file, "AG/tasks/queue/0001-a.md", "duplicate resolution is file-order deterministic");
  assert.deepEqual(tasks[1]?.blocked_by, ["0001"], "placeholders and self-reference removed");
});

test("scheduleNextWave is deterministic and stamps graph identity", () => {
  const tasks = [
    schedulable("0002", "AG/tasks/queue/0002-b.md", ["0001"]),
    schedulable("0001", "AG/tasks/queue/0001-a.md"),
  ];
  const first = scheduleNextWave(wavePlanInput({ tasks, waveSequence: 2 }));
  const second = scheduleNextWave(wavePlanInput({ tasks: [...tasks].reverse(), waveSequence: 2 }));

  // Prefiksas seka `WAVE_SCHEDULER_VERSION`, o ne konstantą testo tekste: versija pakelta į 2, kai
  // planavimas perėjo prie kanoninio grafo, ir būtent tas kėlimas paverčia senus snapshot'us stale.
  assert.equal(WAVE_SCHEDULER_VERSION, 2, "grafo semantikos kėlimas užfiksuotas versijoje");
  assert.match(first.graph_hash, /^wg2:[0-9a-f]{16}$/, "graph hash format is wg<rules>:<sha256/16>");
  assert.equal(first.graph_hash, computeGraphHash(tasks), "plan hash equals standalone hash");
  assert.equal(first.wave_id, `w2-${first.graph_hash.split(":")[1]}`, "wave id is sequence + hash suffix");
  assert.equal(first.wave_sequence, 2);
  assert.deepEqual(first, second, "input order does not change the plan");
});

// APVERSTAS 2026-08-23 (suvienodinimas 3/3). Iki tol šis testas prikaldavo taisyklę „dingusi
// priklausomybė laikoma įvykdyta už bangos ribų" — t. y. įtvirtindavo fail-open elgesį kaip
// laukiamą. Taisyklė gyvavo todėl, kad banga matė tik eilės pjūvį ir negalėjo atskirti „blokatorius
// jau atliktas" nuo „blokatoriaus išvis nėra". Su kanoniniu grafu tas skirtumas MATOMAS, tad
// spėjimo nebereikia: neišsprendžiama nuoroda reiškia, kad leidimo įrodyti negalime.
//
// Testas neištrintas, o apverstas sąmoningai: jis lieka vieta, kur ši taisyklė yra pareikšta.
test("scheduleNextWave dependency semantics: internal and unresolvable both block, completed satisfies", () => {
  const tasks = [
    schedulable("0001", "AG/tasks/queue/0001-a.md"),
    schedulable("0002", "AG/tasks/queue/0002-b.md", ["0001"]),
    schedulable("0003", "AG/tasks/queue/0003-c.md", ["0999"]),
  ];

  const plan = scheduleNextWave(wavePlanInput({ tasks }));
  assert.deepEqual(
    plan.ready.map((task) => task.task_id),
    ["0001"],
    "neišsprendžiama priklausomybė NEBĖRA laikoma įvykdyta",
  );
  assert.deepEqual(plan.external_dependencies, ["0999"], "laukas išlaikytas ir gauna missing reikšmes");
  const blockedB = plan.blocked.find((task) => task.task_id === "0002");
  assert.equal(blockedB?.reason, "unsatisfied-dependency");
  assert.deepEqual(blockedB?.waiting_for, ["0001"]);
  const blockedC = plan.blocked.find((task) => task.task_id === "0003");
  assert.equal(blockedC?.reason, "unsatisfied-dependency", "dingęs blokatorius stabdo, o ne praleidžia");
  assert.deepEqual(blockedC?.waiting_for, ["0999"], "įvardijama TA PATI nuoroda, kurią parašė autorius");

  const completedPlan = scheduleNextWave(wavePlanInput({ tasks, completedTaskIds: ["0001"] }));
  assert.deepEqual(
    completedPlan.ready.map((task) => task.task_id),
    ["0002"],
    "įvykdytas blokatorius atrakina savo priklausinį; `0003` toliau laukia neegzistuojančio `0999`",
  );
});

test("scheduleNextWave blocked branch: root and transitive dependents never become ready", () => {
  const tasks = [
    schedulable("0001", "AG/tasks/queue/0001-a.md"),
    schedulable("0002", "AG/tasks/queue/0002-b.md", ["0001"]),
    schedulable("0003", "AG/tasks/queue/0003-c.md", ["0002"]),
    schedulable("0004", "AG/tasks/queue/0004-d.md"),
  ];
  const branch = collectBlockedBranch(tasks, "0001");
  assert.deepEqual(branch, ["0001", "0002", "0003"], "branch closure is transitive");

  const plan = scheduleNextWave(wavePlanInput({ tasks, blockedTaskIds: branch }));
  assert.deepEqual(
    plan.ready.map((task) => task.task_id),
    ["0004"],
    "independent branch keeps executing",
  );
  for (const taskId of branch) {
    assert.equal(plan.blocked.find((task) => task.task_id === taskId)?.reason, "branch-blocked");
  }
});

test("scheduleNextWave cycle detection blocks participants without stopping independent work", () => {
  const plan = scheduleNextWave(
    wavePlanInput({
      tasks: [
        schedulable("0001", "AG/tasks/queue/0001-a.md", ["0002"]),
        schedulable("0002", "AG/tasks/queue/0002-b.md", ["0001"]),
        schedulable("0003", "AG/tasks/queue/0003-c.md"),
      ],
    }),
  );

  assert.deepEqual(plan.cycles, [["0001", "0002"]], "cycle group is sorted");
  assert.equal(plan.blocked.filter((task) => task.reason === "dependency-cycle").length, 2);
  assert.deepEqual(
    plan.ready.map((task) => task.task_id),
    ["0003"],
  );
});

test("scheduleNextWave ready order: depth first, then file name", () => {
  const plan = scheduleNextWave(
    wavePlanInput({
      tasks: [
        schedulable("0003", "AG/tasks/queue/0003-deep.md", ["0001"]),
        schedulable("0002", "AG/tasks/queue/0002-b.md"),
        schedulable("0001", "AG/tasks/queue/0001-a.md"),
      ],
      completedTaskIds: ["0001"],
    }),
  );

  assert.deepEqual(
    plan.ready.map((task) => [task.task_id, task.depth]),
    [
      ["0002", 0],
      ["0003", 1],
    ],
    "shallower nodes first; depth survives even when the blocker already completed",
  );
});

test("clampWaveWorkers: default 1, hard cap 2", () => {
  assert.equal(WAVE_MAX_WORKERS, 1);
  assert.equal(WAVE_WORKER_HARD_CAP, 2);
  assert.equal(clampWaveWorkers(undefined), 1);
  assert.equal(clampWaveWorkers(0), 1);
  assert.equal(clampWaveWorkers(2), 2);
  assert.equal(clampWaveWorkers(5), 2, "requests above the hard cap are clamped, never honored");
  assert.equal(clampWaveWorkers(Number.NaN), 1);
});

test("selectNextWaveTask skips tasks already started in this run", () => {
  const plan = scheduleNextWave(
    wavePlanInput({
      tasks: [schedulable("0001", "AG/tasks/queue/0001-a.md"), schedulable("0002", "AG/tasks/queue/0002-b.md")],
    }),
  );
  assert.equal(selectNextWaveTask(plan)?.task_id, "0001");
  assert.equal(selectNextWaveTask(plan, { startedTaskIds: ["0001"] })?.task_id, "0002");
  assert.equal(selectNextWaveTask(plan, { startedTaskIds: ["0001", "0002"] }), undefined);
});

// ---------------------------------------------------------------------------
// buildReadySet
// ---------------------------------------------------------------------------

test("buildReadySet gate order: status, dependencies, approval, budget", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/done/0001-a.md", status: "done", checks: ["pnpm test"], scope: ["src"] },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["pnpm test"], scope: ["src"], depends_on: ["0001"] },
      { task_id: "0003", file: "AG/tasks/queue/0003-c.md", checks: ["pnpm test"], scope: ["src"], depends_on: ["0002"] },
      { task_id: "0004", file: "AG/tasks/active/0004-d.md", status: "running", checks: ["pnpm test"], scope: ["src"] },
      {
        task_id: "0005",
        file: "AG/tasks/queue/0005-e.md",
        checks: ["pnpm test"],
        scope: ["src"],
        requires_approval: true,
      },
    ],
  });

  const readySet = buildReadySet({ graph });
  assert.equal(readySet.executable, true);
  assert.equal(readySet.graph_hash, graph.graph_hash);
  assert.deepEqual(
    readySet.ready.map((task) => task.task_id),
    ["0002"],
    "done node drops out entirely; only the satisfied queued node is ready",
  );
  const reasonOf = (taskId: string) => readySet.blocked.find((task) => task.task_id === taskId)?.reason;
  assert.equal(reasonOf("0003"), "unsatisfied-dependency");
  assert.equal(reasonOf("0004"), "not-queued");
  assert.equal(reasonOf("0005"), "approval-required");

  const approved = buildReadySet({ graph, approvals: ["0005"] });
  assert.ok(
    approved.ready.some((task) => task.task_id === "0005"),
    "run-time approval unlocks the gated node",
  );

  const overridden = buildReadySet({ graph, statusOverrides: [["0002", "done"]] as const });
  assert.ok(
    overridden.ready.some((task) => task.task_id === "0003"),
    "status override satisfies the dependency without rewriting the snapshot",
  );
});

test("buildReadySet budget gates: exhausted stops everything, insufficient stops only the estimate", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/queue/0001-a.md", checks: ["x"], scope: ["src"], estimated_tokens: 500 },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["x"], scope: ["src"], estimated_tokens: 50 },
    ],
  });

  const exhausted = buildReadySet({ graph, budget: { exhausted: true } });
  assert.equal(exhausted.ready.length, 0);
  assert.ok(exhausted.blocked.every((task) => task.reason === "budget-exhausted"));

  const partial = buildReadySet({ graph, budget: { remaining_tokens: 100 } });
  assert.deepEqual(
    partial.ready.map((task) => task.task_id),
    ["0002"],
  );
  assert.equal(partial.blocked.find((task) => task.task_id === "0001")?.reason, "budget-insufficient");
});

test("buildReadySet graph-level failures block every node", () => {
  const cyclic = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/queue/0001-a.md", checks: ["x"], scope: ["src"], depends_on: ["0002"] },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["x"], scope: ["src"], depends_on: ["0001"] },
      { task_id: "0003", file: "AG/tasks/queue/0003-c.md", checks: ["x"], scope: ["src"] },
    ],
  });
  const readySet = buildReadySet({ graph: cyclic });
  assert.equal(readySet.executable, false, "cycle is a graph-scope error");
  assert.equal(readySet.ready.length, 0, "nothing executes on an invalid graph");
  assert.ok(readySet.blocked.every((task) => task.reason === "graph-invalid"));
});

test("buildReadySet node-level dependency failures: missing and invalid-terminal", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/failed/0001-a.md", status: "failed", checks: ["x"], scope: ["src"] },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["x"], scope: ["src"], depends_on: ["0001"] },
      { task_id: "0003", file: "AG/tasks/queue/0003-c.md", checks: ["x"], scope: ["src"], depends_on: ["0999"] },
    ],
  });
  const readySet = buildReadySet({ graph });
  assert.equal(readySet.executable, true, "node-scope errors do not invalidate the whole graph");
  const entryOf = (taskId: string) => readySet.blocked.find((task) => task.task_id === taskId);
  assert.equal(entryOf("0002")?.reason, "invalid-terminal-dependency");
  assert.deepEqual(entryOf("0002")?.waiting_for, ["0001"]);
  assert.equal(entryOf("0003")?.reason, "missing-dependency");
  assert.deepEqual(entryOf("0003")?.waiting_for, ["0999"]);
});

// ---------------------------------------------------------------------------
// applyReadySetGates + formatWaveBlockedReason
// ---------------------------------------------------------------------------

test("applyReadySetGates is subtract-only and returns the same object when nothing changes", () => {
  const tasks = [schedulable("0001", "AG/tasks/queue/0001-a.md"), schedulable("0002", "AG/tasks/queue/0002-b.md")];
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/queue/0001-a.md", checks: ["x"], scope: ["src"], estimated_tokens: 900 },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["x"], scope: ["src"], estimated_tokens: 10 },
    ],
  });
  const plan = scheduleNextWave({ tasks, graph });

  assert.equal(applyReadySetGates(plan, undefined), plan, "no ready set = no gates");
  const unconstrained = buildReadySet({ graph });
  assert.equal(applyReadySetGates(plan, unconstrained), plan, "no gated reasons = same object identity");

  const budgeted = buildReadySet({ graph, budget: { remaining_tokens: 100 } });
  const gated = applyReadySetGates(plan, budgeted);
  assert.notEqual(gated, plan);
  assert.deepEqual(
    gated.ready.map((task) => task.task_id),
    ["0002"],
    "only the budget-blocked task is removed; order of the rest untouched",
  );
  const removed = gated.blocked.find((task) => task.task_id === "0001");
  assert.equal(removed?.reason, "gate:budget-insufficient", "graph gate keeps the gate: prefix");
  assert.equal(gated.wave_id, plan.wave_id, "wave identity never changes");

  assert.equal(applyReadySetGates(plan, budgeted, { enforce: [] }), plan, "empty policy disables all gates");
  const notQueuedGate = applyReadySetGates(plan, unconstrained, { enforce: ["not-queued"] });
  assert.equal(notQueuedGate, plan, "explicit non-default gate with no matching blocked entries is a no-op");
});

// Kanoninio grafo, kaip PRODUKCINIO autoriteto, vartai gyvena `scheduling-ready-set-authority`.

test("formatWaveBlockedReason: sorted by task id, capped with overflow summary", () => {
  const blocked = [
    { task_id: "0003", file: "c.md", reason: "unsatisfied-dependency" as const, blocked_by: [], waiting_for: ["0001", "0002"] },
    { task_id: "0001", file: "a.md", reason: "branch-blocked" as const, blocked_by: [], waiting_for: [] },
    { task_id: "0002", file: "b.md", reason: "dependency-cycle" as const, blocked_by: [], waiting_for: ["0003"] },
  ];

  assert.equal(formatWaveBlockedReason("wave-blocked", []), "wave-blocked");
  assert.equal(
    formatWaveBlockedReason("wave-blocked", blocked),
    "wave-blocked; 0001=branch-blocked; 0002=dependency-cycle<-0003; 0003=unsatisfied-dependency<-0001+0002",
  );
  assert.equal(
    formatWaveBlockedReason("wave-blocked", blocked, { limit: 1 }),
    "wave-blocked; 0001=branch-blocked; +2 more",
  );
});

// ---------------------------------------------------------------------------
// decideResume
// ---------------------------------------------------------------------------

const RESUMABLE: ResumeEvidence = { location: "resumable-bucket", acceptedCommit: false };

test("decideResume rule order: accepted commit trumps a stale graph", () => {
  const missing = decideResume(undefined, RESUMABLE);
  assert.equal(missing.action, "no-checkpoint");
  assert.equal(missing.reason, "rr1:no-checkpoint missing-checkpoint");
  assert.equal(missing.replay_safe, false);

  assert.deepEqual(decideResume({ status: "started" }, RESUMABLE).reason_codes, ["missing-task-id"]);

  const completed = decideResume(
    { status: "started", task_id: "0007" },
    { ...RESUMABLE, completedTaskIds: ["0007"] },
  );
  assert.equal(completed.action, "skip-completed");
  assert.deepEqual(completed.reason_codes, ["already-completed"]);

  const accepted = decideResume(
    { status: "started", task_id: "0007", graph_hash: "wg1:old" },
    { location: "queue", acceptedCommit: true, currentGraphHash: "wg1:new" },
  );
  assert.equal(accepted.action, "skip-completed");
  assert.deepEqual(accepted.reason_codes, ["accepted-commit"], "accepted commit wins against graph mismatch");

  const stale = decideResume(
    { status: "started", task_id: "0007", graph_hash: "wg1:old" },
    { location: "queue", acceptedCommit: false, currentGraphHash: "wg1:new" },
  );
  assert.equal(stale.action, "discard-stale");
  assert.deepEqual(stale.reason_codes, ["graph-hash-mismatch"]);
});

test("decideResume location branches and dispatch gate", () => {
  const checkpoint = { status: "started" as const, task_id: "0007" };

  assert.equal(decideResume(checkpoint, { location: "terminal-bucket", acceptedCommit: false }).action, "skip-completed");

  const finishedAbsent = decideResume({ ...checkpoint, status: "finished" }, { location: "absent", acceptedCommit: false });
  assert.deepEqual(finishedAbsent.reason_codes, ["checkpoint-finished"]);
  const startedAbsent = decideResume(checkpoint, { location: "absent", acceptedCommit: false });
  assert.equal(startedAbsent.action, "escalate-human");
  assert.equal(startedAbsent.replay_safe, false);

  const requeued = decideResume(checkpoint, { location: "queue", acceptedCommit: false });
  assert.equal(requeued.action, "retry-task");
  assert.equal(requeued.replay_safe, true);

  const interrupted = decideResume(checkpoint, RESUMABLE);
  assert.equal(interrupted.action, "resume-attempt");
  assert.equal(interrupted.replay_safe, true);
});

// conflict-detector testai gyvena `scheduling-conflict-detector` — iškelti 2026-08-23 dėl 500
// eilučių vartų. Riba natūrali: ten sprendžiama, ar DU task'ai gali dirbti vienu metu, o ne kokia
// yra bangos tvarka.

