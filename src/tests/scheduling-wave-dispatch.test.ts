// VQ-504 (50/N) testai — bangos dispatch'as.
//
// Dvi puses: KURIUOS slot'us paleisti (planavimas siaurina pool'ą) ir KAIP juos sukti. Antroji
// dalis yra ta, kurioje lenktynės kainuotų brangiausiai: `beginTask` ir `recordOutcome` liečia
// bendrą būseną, tad jie serializuojami, o `runTask` — ne.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchWaveSlots, planWaveDispatch, waveSelectionForSlot, type WaveDispatchSlot } from "../application/scheduling/wave-dispatch.js";
import type { WaveSelection } from "../application/scheduling/wave-scheduler-contract.js";
import type { LoopControlState } from "../application/scheduling/loop-control-store.js";
import type { WorkerPoolPlan } from "../application/scheduling/worker-pool-plan.js";
import type { PhantomWaveSlot } from "../application/scheduling/wave-phantom-slots.js";
import type { SlotChildOutcome } from "../application/scheduling/slot-task-runner.js";
import { USAGE_LIMIT_EXIT_CODE } from "../shared/exit-codes.js";

const SUCCEEDED: SlotChildOutcome = { status: "succeeded" };

function control(w1 = "run", w2 = "run"): LoopControlState {
  return { slots: { w1: { mode: w1 }, w2: { mode: w2 } } } as LoopControlState;
}

function selection(options: {
  slots?: { worker_id: string; task_id: string; file: string; worktree_path?: string }[];
  phantom?: PhantomWaveSlot[];
} = {}): Extract<WaveSelection, { kind: "task" }> {
  const slots = options.slots ?? [
    { worker_id: "w1", task_id: "0001", file: "AG/tasks/queue/0001.md" },
    { worker_id: "w2", task_id: "0002", file: "AG/tasks/queue/0002.md", worktree_path: ".worktrees/w2" },
  ];
  return {
    kind: "task",
    task: { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [], depth: 0 },
    absoluteFile: "D:/repo/AG/tasks/queue/0001.md",
    plan: {
      scheduler_version: 1,
      wave_id: "w1",
      wave_sequence: 1,
      graph_hash: "h",
      decision_hash: "dh1:test",
      max_workers: 2,
      ready: slots.map((slot) => ({ task_id: slot.task_id, file: slot.file, blocked_by: [], depth: 0 })),
      blocked: [],
      external_dependencies: [],
      cycles: [],
    },
    pool: {
      slots: slots.map((slot, index) => ({ ...slot, worker_index: index + 1, attempt: 1 })),
    } as unknown as WorkerPoolPlan,
    ...(options.phantom === undefined ? {} : { phantom: options.phantom }),
  };
}

const abs = (file: string): string => `D:/repo/${file}`;

test("tuščias pool'o planas duoda VIENĄ slot'ą pasirinktam task'ui", () => {
  const plan = planWaveDispatch(
    { ...selection(), pool: { slots: [] } as unknown as WorkerPoolPlan },
    control(),
    abs,
  );
  assert.equal(plan.dispatch.length, 1);
  assert.equal(plan.dispatch[0]?.worker_id, "w1");
  assert.equal(plan.halted, false);
});

test("sustabdytas `w1` sulaiko ir tolesnius slot'us", () => {
  const plan = planWaveDispatch(selection(), control("drain", "run"), abs);
  // Kitaip antrasis task'as pasisavintų pirmojo slot'o vietą, kurios operatorius neleido.
  assert.deepEqual(plan.dispatch, []);
  assert.deepEqual(
    plan.withheld.map((slot) => slot.reason),
    ["w1:drain", "w2:run"],
  );
  assert.equal(plan.halted, true);
});

test("fantomas prefikso NENUKERTA", () => {
  const plan = planWaveDispatch(
    selection({ phantom: [{ worker_id: "w1", task_id: "0001", reason: "lease-absent", detail: "lease dingo" }] }),
    control(),
    abs,
  );
  // Fantomas nėra operatoriaus sprendimas: gretimas slot'as su savo darbo kopija lieka izoliuotas.
  assert.deepEqual(
    plan.dispatch.map((slot) => slot.worker_id),
    ["w2"],
  );
  assert.equal(plan.withheld[0]?.phantom, true);
  assert.equal(plan.withheld[0]?.reason, "phantom:lease-absent");
});

test("antrinis slot'as be darbo kopijos SULAIKOMAS", () => {
  const plan = planWaveDispatch(
    selection({
      slots: [
        { worker_id: "w1", task_id: "0001", file: "AG/tasks/queue/0001.md" },
        { worker_id: "w2", task_id: "0002", file: "AG/tasks/queue/0002.md" },
      ],
    }),
    control(),
    abs,
  );
  assert.deepEqual(
    plan.dispatch.map((slot) => slot.worker_id),
    ["w1"],
  );
  assert.equal(plan.withheld[0]?.reason, "missing-worktree");
});

test("pozicija imama iš PLANO, ne iš dispatch'intų kiekio", () => {
  // w1 fantomas, w2 be kopijos: antrasis vis tiek lieka antrasis ir kopijos reikalavimas galioja.
  const plan = planWaveDispatch(
    selection({
      slots: [
        { worker_id: "w1", task_id: "0001", file: "AG/tasks/queue/0001.md" },
        { worker_id: "w2", task_id: "0002", file: "AG/tasks/queue/0002.md" },
      ],
      phantom: [{ worker_id: "w1", task_id: "0001", reason: "lease-absent", detail: "lease dingo" }],
    }),
    control(),
    abs,
  );
  assert.deepEqual(plan.dispatch, []);
  assert.equal(plan.halted, true);
  assert.ok(plan.withheld.some((slot) => slot.reason === "missing-worktree"));
});

test("slot'o pasirinkimas ima TO slot'o task'ą iš plano", () => {
  const base = selection();
  const rewritten = waveSelectionForSlot(base, {
    worker_id: "w2",
    task_id: "0002",
    file: "AG/tasks/queue/0002.md",
    absoluteFile: "D:/repo/AG/tasks/queue/0002.md",
  });
  assert.equal(rewritten.task.task_id, "0002");
  assert.equal(rewritten.absoluteFile, "D:/repo/AG/tasks/queue/0002.md");
});

function slot(workerId: string, taskId: string): WaveDispatchSlot {
  return { worker_id: workerId, task_id: taskId, file: `${taskId}.md`, absoluteFile: `D:/repo/${taskId}.md` };
}

test("`beginTask` nuoseklus, `runTask` lygiagretus", async () => {
  const order: string[] = [];
  let concurrent = 0;
  let peak = 0;

  await dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
    beginTask: (entry) => {
      order.push(`begin:${entry.task_id}`);
      return Promise.resolve();
    },
    runTask: async (entry) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      order.push(`run:${entry.task_id}`);
      return SUCCEEDED;
    },
    recordOutcome: (taskId) => {
      order.push(`outcome:${taskId}`);
      return Promise.resolve();
    },
  });

  assert.deepEqual(order.slice(0, 2), ["begin:0001", "begin:0002"], "įrašai plano tvarka");
  assert.equal(peak, 2, "suteiktas slot'as dirba, o ne laukia");
});

test("baigtys fiksuojamos po VIENĄ, net kai slot'ai baigia kartu", async () => {
  let inside = 0;
  let overlapped = false;

  await dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
    beginTask: () => Promise.resolve(),
    runTask: () => Promise.resolve(SUCCEEDED),
    recordOutcome: async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 3));
      inside -= 1;
    },
  });

  // Dvi lygiagrečios mutacijos viena kitos įrašą perrašytų.
  assert.equal(overlapped, false);
});

test("vieno lane'o metimas NUTRAUKIA run'ą, bet tik palaukus kitų", async () => {
  const finished: string[] = [];
  await assert.rejects(
    () =>
      dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
        beginTask: () => Promise.resolve(),
        runTask: async (entry) => {
          if (entry.task_id === "0001") throw new Error("child nulūžo");
          await new Promise((resolve) => setTimeout(resolve, 10));
          finished.push(entry.task_id);
          return SUCCEEDED;
        },
        recordOutcome: () => Promise.resolve(),
      }),
    /child nulūžo/,
  );
  // Palikti gyvą lygiagretų vykdymą be priežiūros reikštų, kad jo darbas dingsta be įrašo.
  assert.deepEqual(finished, ["0002"]);
});

test("klaida matoma JOS momentu, ne po visų lane'ų", async () => {
  const seen: string[] = [];
  await assert.rejects(
    () =>
      dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
        beginTask: () => Promise.resolve(),
        runTask: async (entry) => {
          if (entry.task_id === "0001") throw new Error("bum");
          await new Promise((resolve) => setTimeout(resolve, 10));
          seen.push("late-finish");
          return SUCCEEDED;
        },
        recordOutcome: () => Promise.resolve(),
        onLaneError: (entry) => {
          seen.push(`error:${entry.task_id}`);
          return Promise.resolve();
        },
      }),
    /bum/,
  );
  assert.deepEqual(seen, ["error:0001", "late-finish"]);
});

test("papildymas kviečiamas TIK kol kitas lane'as dar dirba", async () => {
  const refilled: string[] = [];
  await dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
    beginTask: () => Promise.resolve(),
    runTask: async (entry) => {
      // 0002 dirba ilgiau, tad 0001 baigdamas turi ką papildyti.
      if (entry.task_id === "0002") await new Promise((resolve) => setTimeout(resolve, 15));
      return SUCCEEDED;
    },
    recordOutcome: () => Promise.resolve(),
    refill: (freed) => {
      refilled.push(freed.task_id);
      return Promise.resolve(undefined);
    },
  });

  // Paskutinis lane'as nepapildomas: valdymas privalo grįžti į išorinį bangos ciklą.
  assert.deepEqual(refilled, ["0001"]);
});

test("papildytas slot'as sukamas tame pačiame lane'e", async () => {
  const ran: string[] = [];
  let given = false;
  const results = await dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
    beginTask: () => Promise.resolve(),
    runTask: async (entry) => {
      ran.push(entry.task_id);
      if (entry.task_id === "0002") await new Promise((resolve) => setTimeout(resolve, 15));
      return SUCCEEDED;
    },
    recordOutcome: () => Promise.resolve(),
    refill: () => {
      if (given) return Promise.resolve(undefined);
      given = true;
      return Promise.resolve(slot("w1", "0003"));
    },
  });

  assert.ok(ran.includes("0003"));
  assert.equal(results.length, 3, "kiekvieno task'o baigtis grąžinama atskirai");
});

test("vieno slot'o banga papildymo NEPRAŠO", async () => {
  let asked = 0;
  await dispatchWaveSlots([slot("w1", "0001")], {
    beginTask: () => Promise.resolve(),
    runTask: () => Promise.resolve(SUCCEEDED),
    recordOutcome: () => Promise.resolve(),
    refill: () => {
      asked += 1;
      return Promise.resolve(undefined);
    },
  });
  // Vieno slot'o kelias lieka baitas į baitą toks pat kaip be papildymo.
  assert.equal(asked, 0);
});

test("baigtis pasiekia `recordOutcome` NEPAKEISTA — infra exit kodas neišnyksta", async () => {
  // 148-c-04: iki tol `runTask` grąžindavo `boolean`, ir usage limitas (75) čia tapdavo tuo pačiu
  // `false` kaip raudoni testai — baigties apskaita nebeturėjo iš ko jų atskirti.
  const recorded: [string, SlotChildOutcome][] = [];
  const results = await dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
    beginTask: () => Promise.resolve(),
    runTask: (entry) =>
      Promise.resolve(
        entry.task_id === "0001" ? { status: "infrastructure", code: USAGE_LIMIT_EXIT_CODE } : { status: "task-failed", code: 1 },
      ),
    recordOutcome: (taskId, outcome) => {
      recorded.push([taskId, outcome]);
      return Promise.resolve();
    },
  });

  assert.deepEqual(
    recorded.sort((left, right) => left[0].localeCompare(right[0])),
    [
      ["0001", { status: "infrastructure", code: USAGE_LIMIT_EXIT_CODE }],
      ["0002", { status: "task-failed", code: 1 }],
    ],
  );
  // `ok` lieka dvejetainis iškvietėjui, kuriam užtenka „pavyko / nepavyko".
  assert.deepEqual(
    results.map((entry) => entry.ok),
    [false, false],
  );
});

test("nepavykęs baigties įrašas kito slot'o rezultato NESLEPIA", async () => {
  const outcomes: string[] = [];
  await assert.rejects(
    () =>
      dispatchWaveSlots([slot("w1", "0001"), slot("w2", "0002")], {
        beginTask: () => Promise.resolve(),
        runTask: () => Promise.resolve(SUCCEEDED),
        recordOutcome: (taskId) => {
          outcomes.push(taskId);
          return taskId === "0001" ? Promise.reject(new Error("snapshot EPERM")) : Promise.resolve();
        },
      }),
    /snapshot EPERM/,
  );
  // Antro slot'o baigtis vis tiek užfiksuota: kitaip banga niekada neužsidarytų.
  assert.deepEqual(outcomes.sort(), ["0001", "0002"]);
});
