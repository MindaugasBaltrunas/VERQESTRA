// VQ-504 (53/N) testai — loop'o ciklas.
//
// Visa ciklo vertė yra sustojimo taškuose, tad būtent jie ir tikrinami: stop tikrinamas DUKART,
// nešvarus medis sustabdo PRIEŠ dispatch'ą, fantomas eilės NESUSTABDO, o valdiklio sulaikymas —
// sustabdo, kad nesisuktų karštas ratas.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runLoopCycle, type LoopCyclePorts, type SlotRunOutcome } from "../application/scheduling/loop-cycle.js";
import type { WaveScheduler, WaveSelection } from "../application/scheduling/wave-scheduler-contract.js";
import type { WorkerPoolPlan } from "../application/scheduling/worker-pool-plan.js";
import type { LoopControlState } from "../application/scheduling/loop-control-store.js";
import type { PhantomWaveSlot } from "../application/scheduling/wave-phantom-slots.js";
import type { SlotRefillHold } from "../application/scheduling/slot-refill.js";
import { WorkflowInfrastructureError } from "../shared/errors.js";
import { USAGE_LIMIT_EXIT_CODE } from "../shared/exit-codes.js";

function taskSelection(options: { phantom?: PhantomWaveSlot[]; taskId?: string } = {}): Extract<WaveSelection, { kind: "task" }> {
  const taskId = options.taskId ?? "0001";
  return {
    kind: "task",
    task: { task_id: taskId, file: `AG/tasks/queue/${taskId}.md`, blocked_by: [], depth: 0 },
    absoluteFile: `D:/repo/AG/tasks/queue/${taskId}.md`,
    plan: {
      scheduler_version: 1,
      wave_id: "w1",
      wave_sequence: 1,
      graph_hash: "h",
      decision_hash: "dh1:test",
      max_workers: 1,
      ready: [{ task_id: taskId, file: `AG/tasks/queue/${taskId}.md`, blocked_by: [], depth: 0 }],
      blocked: [],
      external_dependencies: [],
      cycles: [],
    },
    pool: {
      slots: [{ worker_id: "w1", worker_index: 1, task_id: taskId, file: `AG/tasks/queue/${taskId}.md`, attempt: 1 }],
    } as unknown as WorkerPoolPlan,
    ...(options.phantom === undefined ? {} : { phantom: options.phantom }),
  };
}

function control(mode = "run"): LoopControlState {
  return { slots: { w1: { mode }, w2: { mode } } } as LoopControlState;
}

type World = {
  ports: LoopCyclePorts;
  logs: string[];
  out: string[];
  events: string[];
  ran: string[];
  blocked: string[];
};

function world(options: {
  selections?: WaveSelection[];
  stops?: boolean[];
  dirty?: { path: string }[];
  control?: LoopControlState;
  emptyAction?: "continue" | "exit";
  runOk?: boolean;
  /** Baigtis PAGAL task'ą, kai reikia struktūrinės formos (`runOk` lieka numatytoji kitiems). */
  slotOutcomes?: Record<string, boolean | SlotRunOutcome>;
  withdrawn?: string[];
  resumable?: { bucket: string; file: string }[];
  auditRepair?: boolean;
} = {}): World {
  const logs: string[] = [];
  const out: string[] = [];
  const events: string[] = [];
  const ran: string[] = [];
  const blocked: string[] = [];
  const selections = [...(options.selections ?? [{ kind: "empty" }])];
  const stops = [...(options.stops ?? [])];
  const resumable = [...(options.resumable ?? [])];
  let emptyQueueCalls = 0;

  const scheduler: WaveScheduler = {
    runId: "r1",
    recoverFromCrash: () => Promise.resolve({ action: "no-checkpoint", reason: "none" } as never),
    nextTask: () => Promise.resolve(selections.shift() ?? ({ kind: "empty" })),
    beginTask: () => Promise.resolve(),
    recordOutcome: () => Promise.resolve(),
    refillSlot: () => Promise.resolve(undefined),
    isSlotWithdrawn: (taskId) => (options.withdrawn ?? []).includes(taskId),
    blockUnrunnableTask: (taskId) => {
      blocked.push(taskId);
      return Promise.resolve();
    },
  };

  const ports: LoopCyclePorts = {
    scheduler,
    absolutePath: (file) => `D:/repo/${file}`,
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    out: (message) => out.push(message),
    recordEvent: (event) => {
      events.push(event.event);
      return Promise.resolve();
    },
    reapDeadLeases: () => Promise.resolve(["LEASE REAPED: w2"]),
    reapOrphanWorktrees: () => Promise.resolve([]),
    reclaimQueue: () => Promise.resolve([]),
    consumeStopRequest: () => Promise.resolve(stops.shift() ?? false),
    readLoopControl: () => Promise.resolve(options.control ?? control()),
    productTreeDirtyEntries: () => Promise.resolve(options.dirty ?? []),
    selectNextResumableTask: () => Promise.resolve(resumable.shift()),
    resumeTask: () => Promise.resolve(true),
    isAuditRepairTask: () => options.auditRepair === true,
    processAuditRepairTask: () => Promise.resolve(),
    // `continue` grąžinamas TIK pirmą kartą: kitaip fake'as suktų begalinį ratą, kurio realus
    // `handleEmptyQueue` nesuka (jame bootstrap bandomas daugiausiai kartą).
    handleEmptyQueue: () => {
      const action = emptyQueueCalls === 0 ? (options.emptyAction ?? "exit") : "exit";
      emptyQueueCalls += 1;
      return Promise.resolve(action);
    },
    runSlotTask: (slot) => {
      ran.push(slot.task_id);
      const outcome = options.slotOutcomes?.[slot.task_id];
      return Promise.resolve(outcome ?? options.runOk ?? true);
    },
  };

  return { ports, logs, out, events, ran, blocked };
}

test("startas nuskina mirusius lease'us PRIEŠ bet kokį darbą", async () => {
  const w = world();
  await runLoopCycle(w.ports);
  assert.equal(w.logs[0], "LEASE REAPED: w2");
});

test("stop rato pradžioje darbo NEIMA", async () => {
  const w = world({ stops: [true], selections: [taskSelection()] });
  await runLoopCycle(w.ports);

  assert.deepEqual(w.ran, []);
  assert.ok(w.out.some((line) => line.includes("stopped by UI request")));
});

test("stop PRIEŠ dispatch'ą pagaunamas antru vartu", async () => {
  // Pirmas tikrinimas rato pradžioje – false, antras (po planavimo) – true.
  const w = world({ stops: [false, true], selections: [taskSelection()] });
  await runLoopCycle(w.ports);

  assert.deepEqual(w.ran, [], "task'as lieka eilėje: `beginTask` dar nekviestas");
  assert.ok(w.logs.some((line) => line.includes("EXITING BEFORE NEXT DISPATCH")));
});

test("nešvarus medis sustabdo ir ĮVARDIJA failus", async () => {
  const w = world({ selections: [taskSelection()], dirty: [{ path: "src/a.ts" }, { path: "src/b.ts" }] });
  await runLoopCycle(w.ports);

  assert.deepEqual(w.ran, []);
  assert.ok(w.logs.some((line) => line.includes("dirty product tree") && line.includes("src/a.ts")));
  assert.ok(w.out.some((line) => line.includes("necommit'intu produkto failu")));
});

test("tuščia eilė su `continue` sukasi toliau, su `exit` baigia", async () => {
  const stopper = world({ emptyAction: "exit" });
  await runLoopCycle(stopper.ports);
  assert.deepEqual(stopper.ran, []);

  const looping = world({ selections: [{ kind: "empty" }, taskSelection()], emptyAction: "continue" });
  await runLoopCycle(looping.ports);
  assert.deepEqual(looping.ran, ["0001"], "po tuščios eilės ratas paima naują darbą");
});

test("bangos aklavietė sustabdo su priežastimis", async () => {
  const w = world({
    selections: [
      {
        kind: "exhausted",
        plan: taskSelection().plan,
        reason: "all-blocked",
        detail: "0002 laukia 0001",
      },
    ],
  });
  await runLoopCycle(w.ports);

  assert.ok(w.logs.some((line) => line.includes("no runnable task") && line.includes("0002 laukia 0001")));
  assert.ok(w.out.some((line) => line.includes("neturi vykdytinu tasku")));
});

test("nutrūkęs task'as tęsiamas PIRMIAU už eilę", async () => {
  const w = world({ resumable: [{ bucket: "active", file: "AG/tasks/active/0009.md" }], selections: [taskSelection()] });
  await runLoopCycle(w.ports);

  assert.ok(w.logs.some((line) => line.includes("RESUME INTERRUPTED TASK")));
  // Po tęsimo ratas grįžta ir paima eilės darbą.
  assert.deepEqual(w.ran, ["0001"]);
});

test("remonto užduotis eina SAVO keliu, ne per įprastą tęsimą", async () => {
  let resumed = 0;
  let repairs = 0;
  const w = world({ resumable: [{ bucket: "error", file: "AG/tasks/error/audit-repair.md" }], auditRepair: true });
  w.ports.resumeTask = () => {
    resumed += 1;
    return Promise.resolve(true);
  };
  w.ports.processAuditRepairTask = () => {
    repairs += 1;
    return Promise.resolve();
  };
  await runLoopCycle(w.ports);

  assert.equal(repairs, 1);
  assert.equal(resumed, 0);
});

test("FANTOMAS eilės nesustabdo — task'as pažymimas nevykdytinu", async () => {
  const w = world({
    selections: [taskSelection({ phantom: [{ worker_id: "w1", task_id: "0001", reason: "lease-absent", detail: "lease dingo" }] })],
  });
  await runLoopCycle(w.ports);

  assert.deepEqual(w.blocked, ["0001"], "failas lieka eilėje žmogui, o loop'as tęsia kitas šakas");
  assert.ok(w.events.includes("loop_slot_phantom"));
  assert.equal(w.out.length, 0, "sustojimo pranešimo nėra: eilė tęsiama");
});

test("valdiklio sulaikymas SUSTABDO, o ne sukasi karštu ratu", async () => {
  const w = world({ selections: [taskSelection(), taskSelection()], control: control("drain") });
  await runLoopCycle(w.ports);

  assert.deepEqual(w.ran, []);
  assert.ok(w.events.includes("loop_slot_drained"));
  assert.ok(w.out.some((line) => line.includes('operatoriaus nustatytas i "drain"')));
});

test("nesėkmingas task'as eilės NENUTRAUKIA", async () => {
  const w = world({ selections: [taskSelection(), taskSelection({ taskId: "0002" })], runOk: false });
  await runLoopCycle(w.ports);

  assert.deepEqual(w.ran, ["0001", "0002"]);
  assert.ok(w.logs.some((line) => line.includes("TASK ENDED NONZERO; CONTINUING QUEUE")));
});

test("ATŠAUKTAS slot'as „ENDED NONZERO“ eilutės NEGAUNA", async () => {
  const w = world({ selections: [taskSelection()], runOk: false, withdrawn: ["0001"] });
  await runLoopCycle(w.ports);

  // Task'ą iš eilės išėmė kitas mechanizmas be jokio bandymo — nesėkmės signalas būtų klaidingas.
  assert.equal(w.logs.some((line) => line.includes("ENDED NONZERO")), false);
});

// EXIT KONTRAKTAS (operatoriaus sprendimas 2026-08-23; anksčiau `runLoopCommand` grąžindavo
// besąlyginį `0`). Tikrinama BAIGTIS, ne exit kodas: kodo pavertimas gyvena kompozicijoje ir yra
// viena eilutė, o čia sprendžiamas tikrasis klausimas — ar loop'as darbą baigė, ar jį paliko.
//
// Kiekvienas sustojimo kelias turi savo atvejį SĄMONINGAI: būtent „naujas kelias tyliai paveldi
// numatytą sėkmę" ir buvo pati klaida. Atvejo nebuvimas naujam keliui dabar matomas kaip spraga.

test("baigtas darbas: tuščia eilė ir operatoriaus stop yra SĖKMĖ", async () => {
  const emptied = await runLoopCycle(world({ emptyAction: "exit" }).ports);
  assert.deepEqual(emptied, { kind: "finished", reason: "queue-empty" });

  const stoppedEarly = await runLoopCycle(world({ stops: [true], selections: [taskSelection()] }).ports);
  assert.deepEqual(stoppedEarly, { kind: "finished", reason: "stop-requested" }, "įvykdytas prašymas nėra gedimas");

  const stoppedLate = await runLoopCycle(world({ stops: [false, true], selections: [taskSelection()] }).ports);
  assert.deepEqual(stoppedLate, { kind: "finished", reason: "stop-requested" }, "antras stop vartas — ta pati baigtis");
});

test("išsekusi banga yra BLOKAS: eilė ne tuščia, o judėti nebėra kur", async () => {
  const w = world({
    selections: [{ kind: "exhausted", plan: taskSelection().plan, reason: "all-blocked", detail: "0002 laukia 0001" }],
  });
  const outcome = await runLoopCycle(w.ports);

  assert.deepEqual(outcome, { kind: "blocked", reason: "wave-exhausted" });
  assert.deepEqual(w.ran, [], "blokuoti task'ai SĄMONINGAI lieka eilėje");
  // Priežastis privalo pasiekti operatorių: exit kodas neša tik dvejetainį atsakymą.
  assert.ok(w.out.some((line) => line.includes("neturi vykdytinu tasku")));
});

test("užterštas medis yra BLOKAS", async () => {
  const outcome = await runLoopCycle(world({ selections: [taskSelection()], dirty: [{ path: "src/a.ts" }] }).ports);
  assert.deepEqual(outcome, { kind: "blocked", reason: "dirty-tree" });
});

test("nedispatch'intas slot'as yra BLOKAS", async () => {
  const outcome = await runLoopCycle(world({ selections: [taskSelection()], control: control("drain") }).ports);
  assert.deepEqual(outcome, { kind: "blocked", reason: "no-slot-dispatched" });
});

// INFRASTRUKTŪROS SLOT BAIGTIS (148-c-04). Iki šio žingsnio ta pati usage limito baigtis turėjo
// dvi semantikas: pirminiame medyje ji nutraukdavo bėgimą (`LOOP ABORT (infrastruktura)`), o vaiko
// slot'e virsdavo „ENDED NONZERO … CONTINUING QUEUE" eilute ir degindavo likusią eilę.

test("infra slot baigtis: naujų slot'ų nebeprovisioninama, o loop'as baigiasi TUO PAČIU infra kodu", async () => {
  const w = world({
    selections: [taskSelection(), taskSelection({ taskId: "0002" })],
    slotOutcomes: { "0001": { kind: "infrastructure", exitCode: USAGE_LIMIT_EXIT_CODE } },
  });

  await assert.rejects(
    () => runLoopCycle(w.ports),
    (error: unknown) =>
      error instanceof WorkflowInfrastructureError &&
      error.exitCode === USAGE_LIMIT_EXIT_CODE &&
      error.message.includes("task=0001"),
    "exit kodas privalo pasiekti tėvą nepakeistas — lygiai kaip in-process kelyje",
  );

  assert.deepEqual(w.ran, ["0001"], "antra banga nebeimama: aplinka, nužudžiusi vaiką, nužudytų ir kitą");
  assert.ok(w.logs.some((line) => line.includes("WAVE SLOT INFRASTRUCTURE EXIT") && line.includes(`exit=${USAGE_LIMIT_EXIT_CODE}`)));
  assert.ok(w.logs.some((line) => line.includes("LOOP ABORT (infrastruktura)") && line.includes("stage=wave-slot")));
  assert.equal(
    w.logs.some((line) => line.includes("CONTINUING QUEUE")),
    false,
    "„eilė tęsiama“ apie nutraukiantį gedimą būtų melas",
  );
  // Priežastis privalo pasiekti operatorių: exit kodas neša tik skaičių.
  assert.ok(w.out.some((line) => line.includes("infrastrukturos gedimu") && line.includes(String(USAGE_LIMIT_EXIT_CODE))));
});

test("infra baigtis LAIKO papildymą: atsilaisvinęs slot'as naujo darbo negauna", async () => {
  // Dviejų slot'ų banga: w1 krinta dėl aplinkos, w2 dar dirba — būtent tas langas, kuriame
  // papildymas duotų naują task'ą tai pačiai sugedusiai aplinkai.
  const selection = taskSelection();
  const twoSlots: Extract<WaveSelection, { kind: "task" }> = {
    ...selection,
    plan: {
      ...selection.plan,
      max_workers: 2,
      ready: [
        { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [], depth: 0 },
        { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [], depth: 0 },
      ],
    },
    pool: {
      slots: [
        { worker_id: "w1", worker_index: 1, task_id: "0001", file: "AG/tasks/queue/0001.md", attempt: 1 },
        {
          worker_id: "w2",
          worker_index: 2,
          task_id: "0002",
          file: "AG/tasks/queue/0002.md",
          attempt: 1,
          worktree_path: ".ag/worktrees/r1/w2",
        },
      ],
    } as unknown as WorkerPoolPlan,
  };

  const holds: SlotRefillHold[] = [];
  let releaseSecond: () => void = () => undefined;
  const secondFinished = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });

  const w = world({ selections: [twoSlots] });
  w.ports.scheduler.refillSlot = (_workerId, hold) => {
    holds.push(hold);
    // Papildymo klausimas užduotas — antrasis slot'as gali baigti.
    releaseSecond();
    return Promise.resolve(undefined);
  };
  w.ports.runSlotTask = async (slot) => {
    w.ran.push(slot.task_id);
    if (slot.worker_id === "w1") return { kind: "infrastructure", exitCode: USAGE_LIMIT_EXIT_CODE };
    await secondFinished;
    return true;
  };

  await assert.rejects(() => runLoopCycle(w.ports), WorkflowInfrastructureError);

  assert.equal(holds.length, 1, "papildymo klausimas užduotas lygiai kartą — atsilaisvinusiam w1");
  assert.deepEqual(
    holds[0],
    { kind: "stop-requested", detail: "loop-infrastructure.abort" },
    "apimtis ta pati kaip `stop` — visas loop'as; priežastis matoma iš `detail`",
  );
  assert.deepEqual(w.ran.sort(), ["0001", "0002"], "jau vykdomas slot'as nenutraukiamas, bet naujo darbo neatsiranda");
});

test("ne-infra ne-nulis baigtis eilės degimo NEKEIČIA", async () => {
  // Kontrolinis atvejis: struktūrinė baigtis pati savaime nieko nestabdo — sustabdo TIK
  // `infrastructure` rūšis. Task'o nesėkmė buvo ir lieka „eilė tęsiama".
  const w = world({
    selections: [taskSelection(), taskSelection({ taskId: "0002" })],
    slotOutcomes: { "0001": { kind: "task-failed" }, "0002": { kind: "succeeded" } },
  });
  const outcome = await runLoopCycle(w.ports);

  assert.deepEqual(w.ran, ["0001", "0002"]);
  assert.ok(w.logs.some((line) => line.includes("TASK ENDED NONZERO; CONTINUING QUEUE")));
  assert.equal(
    w.logs.some((line) => line.includes("LOOP ABORT (infrastruktura)")),
    false,
  );
  assert.deepEqual(outcome, { kind: "finished", reason: "queue-empty" });
});

test("fantomas eilės NEBLOKUOJA — jis nėra loop'o baigtis", async () => {
  // Fantomas pažymi vieną task'ą nevykdytinu ir leidžia ciklui suktis toliau; jei jis būtų
  // paverstas bloku, vienas sugedęs izoliacijos įrodymas sustabdytų visą eilę.
  const phantom = taskSelection({ phantom: [{ worker_id: "w1", task_id: "0001", reason: "no-lease" }] as never });
  const w = world({ selections: [phantom] });
  const outcome = await runLoopCycle(w.ports);

  assert.deepEqual(w.blocked, ["0001"], "task'as pažymėtas nevykdytinu");
  assert.equal(outcome.kind, "finished", "o pats loop'as pasiekė tuščią eilę");
});
