// `/api/dashboard` vaizdo testai (2026-08-23 UI paleidimo auditas, P0-1).
//
// Šio failo egzistavimo priežastis: iki audito abu kontrakto galai buvo tikrinami ATSKIRAI —
// kliento testai patys konstruodavo `DashboardData`, o serverio testai tikrindavo
// `UiControlPlaneData`. Todėl žali 393 testai nepagavo to, kad maršrutas grąžina VISAI KITĄ
// dokumentą. Čia tikrinama būtent siūlė: forma, kurią gauna naršyklė.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildDashboardView,
  markersConflict,
  type DashboardViewPorts,
  type DashboardWaveSnapshot,
} from "../interfaces/http/ui-dashboard-view.js";
import { deriveLoopSlots } from "../interfaces/ui-model/loop-slot-model.js";
import type { LoopControlState } from "../application/scheduling/loop-control-store.js";
import type { UiControlPlaneData } from "../interfaces/ui-model/control-plane-model.js";

/**
 * Laukai, kuriuos `ui-app/src/model/dashboardViewModel.ts` dereferencina BE saugiklio.
 *
 * Sąrašas dubliuojamas `ui-app/src/model/dashboardContract.ts` pusėje SĄMONINGAI: paketai turi
 * atskirus toolchain'us, o vienintelė alternatyva būtų kliento importas iš `src/`, kuris
 * sulaužytų `ui-app` build'ą. Abu sąrašai nurodo vienas į kitą, kad pakeitimas viename be kito
 * neliktų nepastebėtas.
 */
const CLIENT_REQUIRED_FIELDS = [
  "root",
  "currentTaskId",
  "currentTaskFile",
  "claudeExit",
  "stableRef",
  "stopStatus",
  "decision",
  "supervisorResume",
  "claudeResume",
  "runtime",
  "claudeLogUpdatedAt",
  "claudeLogBytes",
  "workflowBuckets",
] as const;

const EMPTY_CONTROL_PLANE: UiControlPlaneData = {
  config_controls: [],
  human_review_tasks: [],
  learning_recommendations: [],
  learning_summary: {
    records: 0,
    by_type: { task_outcome: 0, failure_pattern: 0, context_feedback: 0, policy_recommendation: 0 },
    pending_recommendations: 0,
    approved_recommendations: 0,
    rejected_recommendations: 0,
  },
  policy_controls: [],
};

const RUNNING_CONTROL: LoopControlState = {
  slots: { w1: { mode: "run" }, w2: { mode: "run" } },
};

type FakeInput = {
  /** Raktas — kelio UODEGA (`tasks/active/0042.md`): bucket'o paieškai svarbus VISAS kelias. */
  files?: Record<string, string>;
  snapshot?: DashboardWaveSnapshot;
  failing?: Set<string>;
};

function fakePorts(input: FakeInput = {}): { ports: DashboardViewPorts; errors: string[] } {
  const files = input.files ?? {};
  const errors: string[] = [];
  const fail = (name: string): void => {
    if (input.failing?.has(name)) throw new Error(`fake failure: ${name}`);
  };
  const lookup = (absolutePath: string): string | undefined => {
    const posix = absolutePath.split(path.sep).join("/");
    return Object.entries(files).find(([suffix]) => posix.endsWith(suffix))?.[1];
  };

  return {
    errors,
    ports: {
      ensureDirs: () => Promise.resolve(),
      readTextFileIfExists: (absolutePath) => Promise.resolve(lookup(absolutePath)),
      fileExists: (absolutePath) => Promise.resolve(lookup(absolutePath) !== undefined),
      fileStamp: (absolutePath) =>
        Promise.resolve(lookup(absolutePath) === undefined ? {} : { bytes: 12, updatedAt: "2026-08-23T00:00:00.000Z" }),
      loadWorkflowBuckets: () => {
        fail("workflow_buckets");
        return Promise.resolve([{ name: "queue", tasks: ["0001.md"], totalCount: 1 }]);
      },
      loadControlPlane: () => {
        fail("control_plane");
        return Promise.resolve(EMPTY_CONTROL_PLANE);
      },
      readWorkerRequest: () => Promise.resolve({ requested: 2, source: "state" }),
      readLoopControl: () => Promise.resolve(RUNNING_CONTROL),
      readWaveSnapshot: () => Promise.resolve(input.snapshot),
      listWorkerLeases: () => Promise.resolve([]),
      readStopEvidence: (taskId) =>
        Promise.resolve({
          record: taskId === "" ? {} : { status: "done", reason: "gates passed", task_id: taskId },
          origin: taskId === "" ? "none" : "attempt",
          corrupted: false,
        }),
      readClaudeLogStamp: () => Promise.resolve({ bytes: 4096, updatedAt: "2026-08-23T01:00:00.000Z", source: "legacy" }),
      inspectProcess: (_pidFile, options) =>
        Promise.resolve(options.selfRegistering ? { pid: 4242, status: "running" } : { status: "unknown" }),
      uiProcessPid: () => 1111,
      logError: (message) => errors.push(message),
    },
  };
}

test("atsakymas turi KIEKVIENĄ lauką, kurio klientas reikalauja be saugiklio", async () => {
  const { ports } = fakePorts();
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  for (const field of CLIENT_REQUIRED_FIELDS) {
    assert.ok(field in view, `trūksta lauko '${field}' — klientas jį skaito be saugiklio`);
    assert.notEqual(
      (view as unknown as Record<string, unknown>)[field],
      undefined,
      `laukas '${field}' yra undefined — klientas nulūžtų prieš pirmą renderį`,
    );
  }
  // `controlPlane` yra ĮDĖTAS blokas, o ne pats atsakymas — būtent šito nesutapimo auditas ir ieškojo.
  assert.deepEqual(view.controlPlane?.config_controls, []);
  assert.equal(view.degraded.length, 0);
});

test("tuščia būsena: nėra einamojo task'o, nėra stop įrodymo", async () => {
  const { ports } = fakePorts();
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  assert.equal(view.currentTaskId, null);
  assert.equal(view.currentTaskFile, null);
  assert.equal(view.currentTaskState, "none");
  assert.deepEqual(view.stopStatus, {});
  assert.equal(view.stopStatusSource, "none");
  assert.deepEqual(view.decision, {});
});

test("einamasis task'as: bucket'as randamas, būsena `active`, stop įrodymas attempt-first", async () => {
  const { ports } = fakePorts({
    files: {
      "state/current-task-id": "0042\n",
      "tasks/active/0042.md": "# task",
      "supervisor/decision.json": JSON.stringify({ verdict: "done" }),
      "state/claude-last-exit-code": "0",
    },
  });
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  assert.equal(view.currentTaskId, "0042");
  // `active` ir `delegated` yra vieninteliai bucket'ai, kurie reiškia gyvą darbą; `queue` būtų
  // `stale` — būsenos failas rodo task'ą, kurio niekas nevykdo.
  assert.equal(view.currentTaskBucket, "active");
  assert.equal(view.currentTaskState, "active");
  assert.equal(view.stopStatus["status"], "done");
  assert.equal(view.stopStatusSource, "attempt");
  assert.equal(view.decision["verdict"], "done");
  assert.equal(view.claudeExit, "0");
});

test("prieštaraujančios žymės: ID ir failas aprašo skirtingus task'us — būsena `conflicting`, bucket'as pagal ID", async () => {
  // 2026-09-02 apžvalgos auditas: `current-task-id` liko nuo pirminio medžio dispatch'o, o
  // `current-task-file` integracija nukreipė į svetimą `done/` failą. Iš ID ir svetimo failo
  // bucket'o ekranas lipdė „012-a-02 (done)", nors 012-a-02 gulėjo `queue`.
  const { ports } = fakePorts({
    files: {
      "state/current-task-id": "0042\n",
      "state/current-task-file": "/repo/AG/tasks/done/0099.md\n",
      "tasks/queue/0042.md": "# task",
      "tasks/done/0099.md": "# kitas",
    },
  });
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  assert.equal(view.currentTaskState, "conflicting");
  assert.equal(view.currentTaskBucket, "queue", "bucket'as ieškomas pagal ID, ne pagal svetimą failą");
  assert.equal(markersConflict("0042", "/repo/AG/tasks/done/0099.md"), true);
  assert.equal(markersConflict("0042", "/repo/AG/tasks/active/0042.md"), false);
  assert.equal(markersConflict("0042", null), false, "viena žymė be kitos neprieštarauja");
});

test("degradavęs šaltinis pavadinamas, o ne nutylimas ar paverčiamas 500", async () => {
  const { ports, errors } = fakePorts({ failing: new Set(["control_plane"]) });
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  assert.deepEqual(view.degraded, ["control_plane"]);
  // Blokas PRALEIDŽIAMAS, o ne siunčiamas tuščias: klientui `undefined` reiškia „duomenų nėra",
  // o tuščias sąrašas melagingai reikštų „nieko nelaukia".
  assert.equal(view.controlPlane, undefined);
  assert.equal(errors.some((line) => line.includes("control_plane")), true);
  // Likę laukai nenukenčia — dashboard'as lieka naudojamas.
  assert.equal(view.workflowBuckets.length, 1);
});

test("worker valdiklis neša prašymą IR paskutinės bangos rezultatą", async () => {
  const snapshot: DashboardWaveSnapshot = {
    worker_pool: {
      wave_id: "w1-abc",
      mode: "parallel",
      requested: 2,
      granted: 1,
      max: 2,
      rejected: [{ task_id: "0043", reason: "missing-lease", detail: "" }],
      slots: [{ worker_id: "w1", task_id: "0042", attempt: 1 }],
    },
    tasks: [{ task_id: "0042", state: "running" }],
    live_slots: [],
  };
  const { ports } = fakePorts({ snapshot });
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  assert.equal(view.workerControl.requested, 2);
  assert.equal(view.workerControl.lastWave?.granted, 1);
  assert.equal(view.loopControl.slots.length, 2);
  assert.equal(view.loopControl.slots[0]?.state, "running");
  // Antras slot'as neišduotas — ir tik jis rodo atmetimo priežastį.
  assert.equal(view.loopControl.slots[1]?.state, "idle");
  assert.equal(view.loopControl.slots[1]?.lastWave?.rejected_reason, "missing-lease");
  assert.equal(view.loopControl.slots[0]?.lastWave?.rejected_reason, null);
});

test("runtime sąrašas: UI procesas, loop'as ir vartotojo terminalas", async () => {
  const { ports } = fakePorts();
  const view = await buildDashboardView({ ports, projectRoot: "/repo" });

  assert.deepEqual(
    view.runtime.map((entry) => entry.name),
    ["AG UI", "AG loop", "User Claude terminal"],
  );
  assert.equal(view.runtime[0]?.status, "running");
  assert.equal(view.runtime[1]?.pid, 4242);
  // Pasyvus PID failas be rašytojo: nebuvimas nieko neįrodo, tad lieka `unknown`.
  assert.equal(view.runtime[2]?.status, "unknown");
});

test("`live_slots` yra vykdymo AUTORITETAS: refill slot'as bangos plane neegzistuoja", () => {
  const slots = deriveLoopSlots({
    control: RUNNING_CONTROL,
    snapshot: {
      worker_pool: { wave_id: "w1-abc", granted: 1, rejected: [], slots: [] },
      // Task'o `0099` bangos plano `tasks` sąraše NĖRA — jis atėjo per papildymą (refill).
      tasks: [],
      live_slots: [{ worker_id: "w2", task_id: "0099", attempt: 3 }],
    },
  });

  assert.equal(slots[1]?.task_id, "0099");
  assert.equal(slots[1]?.attempt, 3);
  assert.equal(slots[1]?.state, "running");
  // Be gyvo įrodymo ir be `running` task'o pirmas slot'as lieka tuščias, o ne rodo pasenusį planą.
  assert.equal(slots[0]?.task_id, null);
  assert.equal(slots[0]?.state, "idle");
});

test("operatoriaus `drain` matomas ATSKIRAI nuo realios būsenos", () => {
  const slots = deriveLoopSlots({
    control: { slots: { w1: { mode: "drain" }, w2: { mode: "abort" } } },
    snapshot: {
      tasks: [],
      live_slots: [
        { worker_id: "w1", task_id: "0001", attempt: 1 },
        { worker_id: "w2", task_id: "0002", attempt: 1 },
      ],
    },
  });

  assert.equal(slots[0]?.desired, "drain");
  assert.equal(slots[0]?.state, "draining");
  // `aborting`, o ne `aborted`: vykdomas bandymas užbaigiamas iki galo.
  assert.equal(slots[1]?.desired, "abort");
  assert.equal(slots[1]?.state, "aborting");
});
