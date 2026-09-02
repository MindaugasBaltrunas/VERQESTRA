// VQ-504 (49/N) testai — bangos planuoklio gyvavimo ciklas.
//
// Prikalama tai, kas laiko izoliaciją ir idempotenciją: slot'ų talpa gaunama iš LEIDIMO sprendimo,
// duplikatas fiksuojamas PRIEŠ vykdymą, nevykdytinas task'as blokuoja visą šaką, o resume kelias
// eina per tuos pačius vartus kaip įprastas.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveScheduler, type WaveSchedulerDeps } from "../application/scheduling/wave-scheduler.js";
import { decideResume } from "../application/scheduling/resume-run.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import type { SchedulableTask } from "../application/scheduling/schedule-next-wave.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";
import type { WaveProvisioningCoordinator } from "../application/scheduling/wave-provisioning.js";
import type { WaveIntegrationIo } from "../application/scheduling/wave-scheduler.js";
import type { SchedulerCheckpoint } from "../application/scheduling/wave-scheduler-contract.js";
import type { WaveSnapshot } from "../application/scheduling/wave-snapshot.js";
import type { TaskGraph } from "../domain/tasks/graph/model.js";
import { buildTaskGraph } from "../domain/tasks/graph/build.js";

const NOW = "2026-08-21T12:00:00.000Z";

function tasks(): SchedulableTask[] {
  return [
    { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] },
    { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: ["0001"] },
  ];
}

/**
 * Kanoninis grafas, atitinkantis TĄ PATĮ task sąrašą, kurį grąžina `readTasks`.
 *
 * Anksčiau čia buvo tuščias `as unknown as TaskGraph` stub'as, ir jis darė testų pasaulį
 * prieštaringą: eilėje task'ai yra, o kanoninis autoritetas apie juos nieko nežino. Kol vartai
 * buvo atimtis, tai nieko nekeitė (tuščias grafas nieko nedraudė), bet būtent tokį nesutapimą
 * dabar gaudo `gate:graph-state-mismatch`. Grafas statomas iš to paties sąrašo, tad pasaulis
 * negali išsiderinti tyliai — ir cast'o nebereikia.
 */
function graphFor(list: readonly SchedulableTask[]): TaskGraph {
  return buildTaskGraph({
    nodes: list.map((task) => ({
      task_id: task.task_id,
      file: task.file,
      checks: ["pnpm test"],
      scope: [`src/${task.task_id}.ts`],
      ...(task.blocked_by.length === 0 ? {} : { depends_on: [...task.blocked_by] }),
    })),
  });
}

const integrationIo: WaveIntegrationIo = {
  resolveWorktreeLayout: (identity) => ({ relativePath: `.worktrees/${identity.worker_id}`, branch: `ag/${identity.task_id}` }),
  locateTask: () => Promise.resolve("terminal-bucket"),
  resolvePrimaryHead: () => Promise.resolve("head"),
  integrateBranch: () => Promise.resolve({ status: "integrated", mode: "merge", head: "head2" }),
  integrationTouchedSrc: () => Promise.resolve(false),
  rebuildDist: () => Promise.resolve({ ok: true, detail: "" }),
  pushPrimaryBranch: () => Promise.resolve({ ok: true, branch: "main" }),
  relocateTask: () => Promise.resolve("moved"),
  restoreDoneCopy: () => Promise.resolve({ ok: true, source: "HEAD^" }),
  collectWorktreeTelemetry: () => Promise.resolve({ appended: 0, detail: "" }),
  cleanupWorktree: () => Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" }),
  releaseLease: () => Promise.resolve("released"),
};

const provisioningCoordinator: WaveProvisioningCoordinator = {
  toWorkerCandidates: (list) =>
    list.map(
      (task): WorkerCandidate => ({
        task_id: task.task_id,
        file: task.file,
        write_set: computeTaskWriteSet({ task_id: task.task_id, allowed_paths: [`src/${task.task_id}.ts`] }),
      }),
    ),
  readIsolationInputs: () => Promise.resolve({ leases: [] }),
  provisionSlotLease: () => Promise.resolve(false),
  provisionMissingSlotLeases: () => Promise.resolve([]),
  releaseWaveProvisionLease: () => Promise.resolve(),
};

type World = {
  deps: WaveSchedulerDeps;
  logs: string[];
  // `wave_id` fiksuojamas nuo 2026-08-23: be jo nebuvo įmanoma pastebėti, kad grafo įvykiai
  // gauna ne tos bangos tapatybę — ir būtent todėl tas perėjimas liko nepatikrintas.
  events: { event: string; wave_id: string; task_id?: string | undefined; reason?: string | undefined }[];
  snapshots: number;
  checkpoints: { status: string; task_id?: string }[];
  /** Įrašyti snapshot'ai — iš jų matyti, kuria numeracija banga iš tikrųjų ėjo. */
  written: WaveSnapshot[];
};

function world(options: {
  taskList?: SchedulableTask[];
  checkpoint?: SchedulerCheckpoint | undefined;
  duplicate?: boolean;
  workers?: number;
  locate?: () => Promise<"terminal-bucket" | "queue" | "resumable-bucket" | "absent">;
  accepted?: boolean;
  relocate?: () => Promise<"moved" | "already" | "kept" | "absent">;
  /** Ankstesnio proceso bangos snapshot'as — resume tęsimo šaka. */
  snapshot?: WaveSnapshot | undefined;
  /** Task'ai, kuriems iškvietėjas paduoda patvirtinimą (keičia sprendimą, ne grafą). */
  approvals?: string[];
} = {}): World {
  const logs: string[] = [];
  const events: World["events"] = [];
  const checkpoints: World["checkpoints"] = [];
  const written: WaveSnapshot[] = [];
  const state = { snapshots: 0 };
  const taskList = options.taskList ?? tasks();

  const deps: WaveSchedulerDeps = {
    projectRoot: "D:/repo",
    runId: "r1",
    now: () => NOW,
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    absolutePath: (file) => `D:/repo/${file}`,
    readTasks: () => Promise.resolve(taskList),
    locateTask: options.locate ?? (() => Promise.resolve("queue")),
    hasAcceptedWork: () => Promise.resolve(options.accepted ?? false),
    readCheckpoint: () => Promise.resolve(options.checkpoint),
    readSnapshot: () => Promise.resolve(options.snapshot),
    writeSnapshot: (snapshot) => {
      state.snapshots += 1;
      written.push(snapshot);
      return Promise.resolve();
    },
    recordEvent: (event) => {
      events.push({ event: event.event, wave_id: event.wave_id, task_id: event.task_id, reason: event.reason });
      return Promise.resolve();
    },
    recordCheckpoint: (checkpoint) => {
      checkpoints.push({ status: checkpoint.status, ...(checkpoint.task_id === undefined ? {} : { task_id: checkpoint.task_id }) });
      return Promise.resolve();
    },
    importGraph: () => Promise.resolve(graphFor(taskList)),
    writeGraphSnapshot: () => Promise.resolve(),
    readGraphSnapshot: () => Promise.resolve({ ok: false, reason: "missing", errors: [] }),
    readySetBudget: () => Promise.resolve(undefined),
    approvals: () => options.approvals ?? [],
    requestedWorkers: () => Promise.resolve(options.workers ?? 1),
    ledgerDuplicate: () => Promise.resolve(options.duplicate ?? false),
    integration: { ...integrationIo, ...(options.relocate === undefined ? {} : { relocateTask: options.relocate }) },
    // Fabrikas: planuoklis paduoda savo būseną, o testui pakanka vienos konstantos.
    provisioning: () => provisioningCoordinator,
    readWorkerLeases: () => Promise.resolve([]),
  };

  return {
    deps,
    logs,
    events,
    checkpoints,
    written,
    get snapshots() {
      return state.snapshots;
    },
  };
}

test("tuščia eilė grąžina `empty`", async () => {
  const w = world({ taskList: [] });
  assert.deepEqual(await createWaveScheduler(w.deps).nextTask(), { kind: "empty" });
});

test("pirmas task'as gauna absoliutų kelią ir pool'o planą", async () => {
  const w = world();
  const selection = await createWaveScheduler(w.deps).nextTask();

  assert.equal(selection.kind, "task");
  if (selection.kind !== "task") return;
  assert.equal(selection.task.task_id, "0001");
  assert.equal(selection.absoluteFile, "D:/repo/AG/tasks/queue/0001.md");
  assert.equal(selection.pool.slots.length >= 1, true);
});

test("paleidus blokatorių, likusi šaka duoda `exhausted`, o ne tylą", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  const first = await scheduler.nextTask();
  assert.equal(first.kind, "task");
  if (first.kind !== "task") return;
  await scheduler.beginTask(first);

  const second = await scheduler.nextTask();
  assert.equal(second.kind, "exhausted");
  if (second.kind !== "exhausted") return;
  // 0002 laukia 0001 — kol tas dirba, banga neturi ką siūlyti, ir tai ĮVARDIJAMA.
  assert.equal(second.reason, "all-blocked");
  assert.ok(w.events.some((entry) => entry.event === "wave_blocked"));
});

test("antras task'as be laisvo slot'o META, o ne tyliai praeina", async () => {
  const w = world({ taskList: [
    { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] },
    { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [] },
  ] });
  const scheduler = createWaveScheduler(w.deps);
  const first = await scheduler.nextTask();
  if (first.kind !== "task") throw new Error("laukiamas task");
  await scheduler.beginTask(first);

  // Tyliai leisti dar vieną task'ą reikštų neizoliuotą paralelizmą be konfliktų verdikto.
  await assert.rejects(
    () => scheduler.beginTask({ ...first, task: { ...first.task, task_id: "0002", file: "AG/tasks/queue/0002.md" } }),
    /still running/,
  );
});

test("duplikatas fiksuojamas PRIEŠ vykdymą", async () => {
  const w = world({ duplicate: true });
  const scheduler = createWaveScheduler(w.deps);
  const selection = await scheduler.nextTask();
  if (selection.kind !== "task") throw new Error("laukiamas task");
  await scheduler.beginTask(selection);
  await scheduler.recordOutcome("0001", false);

  // Po vykdymo eilės failo nebelieka, tad be šio įrašo slot'as būtų užverstas kaip žlugęs.
  assert.equal(scheduler.isSlotWithdrawn("0001"), true);
});

test("ledger'io klaida dispatch'o NENUTRAUKIA", async () => {
  const w = world();
  w.deps.ledgerDuplicate = () => Promise.reject(new Error("ledger unreadable"));
  const scheduler = createWaveScheduler(w.deps);
  const selection = await scheduler.nextTask();
  if (selection.kind !== "task") throw new Error("laukiamas task");

  await scheduler.beginTask(selection);
  assert.ok(w.logs.some((line) => line.includes("DUPLICATE PROBE FAILED")));
  assert.ok(w.events.some((entry) => entry.event === "task_started"));
});

test("`beginTask` rašo checkpoint'ą ir įvykį", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  const selection = await scheduler.nextTask();
  if (selection.kind !== "task") throw new Error("laukiamas task");
  await scheduler.beginTask(selection);

  assert.deepEqual(w.checkpoints, [{ status: "started", task_id: "0001" }]);
  assert.ok(w.events.some((entry) => entry.event === "task_started" && entry.task_id === "0001"));
});

test("nevykdytinas task'as blokuoja VISĄ šaką, bet nėra `failed`", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  await scheduler.nextTask();
  await scheduler.blockUnrunnableTask("0001", "adapteris neprieinamas");

  assert.ok(w.events.some((entry) => entry.event === "task_branch_blocked" && entry.task_id === "0001"));
  const next = await scheduler.nextTask();
  // 0002 priklauso nuo 0001 — jo vykdyti negalima.
  assert.equal(next.kind === "task" ? next.task.task_id : next.kind, "exhausted");
});

// 2026-08-23 (operatoriaus radinys): grafo įvykiai po pirmos bangos gaudavo ANKSTESNĮ numerį.
//
// `refresh` gaudavo provizorinį `waveId`, sudėtą iš TUOMETINĖS sekos, o `startWaveIfGraphChanged`
// numerį pakelia tik PO importo. Tad tos pačios bangos istorijoje atsirasdavo
// `graph_unavailable@w1-…` ir `wave_blocked@w2-…`. Vykdymui tai nieko nekeitė, bet audit trail
// priskirdavo klaidą bangai, kurios ji neliečia — o testai šio perėjimo netikrino.
test("grafo įvykiai gauna GALUTINĮ bangos numerį, ne provizorinį", async () => {
  const first = [{ task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] }];
  const second = [...first, { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [] }];
  let taskList = first;

  const w = world({ taskList: first });
  const scheduler = createWaveScheduler({
    ...w.deps,
    readTasks: () => Promise.resolve(taskList),
    // Importo nesėkmė yra pigiausias būdas gauti grafo įvykį kiekvienoje bangoje.
    importGraph: () => Promise.reject(new Error("markdown sugadintas")),
  });

  await scheduler.nextTask();
  const firstWave = w.events.filter((entry) => entry.event === "graph_unavailable").length;
  assert.equal(firstWave, 1, "pirma banga irgi rašo įvykį");

  // Eilė pasikeičia → grafo hash pasikeičia → seka pakyla į 2.
  taskList = second;
  await scheduler.nextTask();

  const waveIds = w.events.filter((entry) => entry.event === "graph_unavailable").map((entry) => entry.wave_id);
  assert.equal(waveIds.length, 2);
  assert.ok(waveIds[1]?.startsWith("w2-"), `antros bangos įvykis privalo nešti w2, gauta ${String(waveIds[1])}`);
  assert.notEqual(waveIds[0], waveIds[1], "dvi skirtingos bangos — dvi skirtingos tapatybės");

  // Ir svarbiausia: TOS PAČIOS bangos įrašai privalo sutapti tarpusavyje. Būtent to ir nebuvo —
  // `graph_unavailable@w1-…` gulėdavo šalia `wave_blocked@w2-…`.
  const secondWave = w.events.filter((entry) => entry.wave_id === waveIds[1]).map((entry) => entry.event);
  assert.ok(secondWave.includes("graph_unavailable") && secondWave.includes("wave_blocked"), secondWave.join(","));
});

// 2026-08-23 (operatoriaus radinys): atkūrimas lygino GRAFO, o ne SPRENDIMO atspaudą. Patvirtinimo
// atšaukimas, biudžeto išsekimas ar statuso pasikeitimas `graph_hash`'o nejudina, tad po kritimo
// banga buvo tęsiama pagal leidimą, kurio nebėra. Šis testas laiko abi puses: nepakitęs sprendimas
// numeraciją TĘSIA, pakitęs — NE.
test("resume tęsia numeraciją tik tada, kai SPRENDIMAS nepakito", async () => {
  const tasks = [{ task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] }];
  const requiresApproval = buildTaskGraph({
    nodes: [{ task_id: "0001", file: "AG/tasks/queue/0001.md", checks: ["pnpm test"], scope: ["src/0001.ts"], requires_approval: true }],
  });

  const runWith = async (snapshot: WaveSnapshot, approvals: string[]) => {
    const w = world({ taskList: tasks, snapshot, approvals });
    const scheduler = createWaveScheduler({ ...w.deps, importGraph: () => Promise.resolve(requiresApproval) });
    await scheduler.recoverFromCrash();
    return w.written.at(-1)?.wave_sequence;
  };

  // Einamosios reikšmės imamos iš tikro paleidimo SU patvirtinimu — ne sugalvojamos.
  const probe = world({ taskList: tasks, approvals: ["0001"] });
  await createWaveScheduler({ ...probe.deps, importGraph: () => Promise.resolve(requiresApproval) }).nextTask();
  const current = probe.written.at(-1);
  assert.ok(current?.decision_hash, "snapshot'as neša sprendimo atspaudą");

  const snapshotWith = (decisionHash: string): WaveSnapshot => ({
    schema_version: 1,
    scheduler_version: 2,
    run_id: "r1",
    wave_id: "w1-x",
    // Svetima numeracija: jei ji atsiras įrašytame snapshot'e, vadinasi banga buvo TĘSIAMA.
    wave_sequence: 7,
    // KRITIŠKA: grafo atspaudas SUTAMPA su einamuoju. Tik taip testas atskiria taisymą nuo
    // senosios logikos — pastaroji lygino būtent šį lauką ir bangą būtų tęsusi.
    graph_hash: current.graph_hash,
    decision_hash: decisionHash,
    max_workers: 1,
    created_at: NOW,
    updated_at: NOW,
    tasks: [],
    external_dependencies: [],
    cycles: [],
    live_slots: [],
  });

  // A. `graph_hash` sutampa, bet sprendimas kitas (snapshot'as darytas be patvirtinimo).
  assert.equal(
    await runWith(snapshotWith("dh1:0000000000000000"), ["0001"]),
    1,
    "sutampantis grafas su KITU sprendimu numeracijos NEtęsia",
  );

  // B. Sutampa ir grafas, ir sprendimas — banga tikrai ta pati.
  assert.equal(await runWith(snapshotWith(current.decision_hash), ["0001"]), 7, "tas pats sprendimas — numeracija tęsiama");
});

test("resume be checkpoint'o nieko nerašo į žurnalą", async () => {
  const w = world();
  const decision = await createWaveScheduler(w.deps).recoverFromCrash();

  assert.equal(decision.action, "no-checkpoint");
  assert.equal(w.events.some((entry) => entry.event === "resume_decision"), false);
});

test("priimtas darbas per resume UŽDAROMAS, o ne kartojamas", async () => {
  const w = world({
    checkpoint: { status: "finished", task_id: "0001", updated_at: NOW },
    locate: () => Promise.resolve("terminal-bucket"),
    accepted: true,
  });
  const scheduler = createWaveScheduler(w.deps);
  const decision = await scheduler.recoverFromCrash();

  assert.equal(decision.action, "skip-completed");
  assert.ok(w.logs.some((line) => line.includes("WAVE RESUME TASK CLOSED")));
  assert.ok(w.events.some((entry) => entry.event === "resume_task_closed"));

  // Uždarytas task'as antrą kartą nebesiūlomas.
  const next = await scheduler.nextTask();
  assert.equal(next.kind === "task" ? next.task.task_id : next.kind, "0002");
});

// Task 115 (2026-09-01): decideResume taisyklių tvarka — terminal-bucket dabar sprendžia PRIEŠ
// grafo hash'ą, tad `done` task'as su svetimu checkpoint.graph_hash gauna `skip-completed`, o
// ne `discard-stale`; resumable vietai stale grafo apsauga (žr. scheduling-waves.test.ts) lieka.
test("decideResume: terminal-bucket trumpa graph-hash mismatch (task 115)", () => {
  const checkpoint = { status: "started" as const, task_id: "0007", graph_hash: "wg1:old" };
  const evidence = { acceptedCommit: false, currentGraphHash: "wg1:new" };
  const terminal = decideResume(checkpoint, { ...evidence, location: "terminal-bucket" });
  assert.equal(terminal.action, "skip-completed");
  assert.deepEqual(terminal.reason_codes, ["terminal-bucket"]);
  assert.equal(decideResume(checkpoint, { ...evidence, location: "resumable-bucket" }).action, "discard-stale");
});

// Task 115 (operatoriaus radinys 095-b-03): `done` bucket'e gulintis task'as su PASENUSIU
// checkpoint'o `graph_hash` anksčiau kiekvieną startą gaudavo `discard-stale` (be uždarymo
// kelio) ir kartojosi be galo, nes checkpoint'as niekad nebuvo perrašomas.
test("terminaliniam task'ui su svetimu graph_hash resume UŽDARO, o ne kartoja discard-stale", async () => {
  const w = world({
    checkpoint: { status: "started", task_id: "0001", updated_at: NOW, graph_hash: "wg1:stale-plan" },
    locate: () => Promise.resolve("terminal-bucket"),
    accepted: false,
  });
  const scheduler = createWaveScheduler(w.deps);
  const decision = await scheduler.recoverFromCrash();

  assert.equal(decision.action, "skip-completed");
  assert.deepEqual(decision.reason_codes, ["terminal-bucket"]);
  assert.ok(w.logs.some((line) => line.includes("WAVE RESUME TASK CLOSED")), "uždarymo kelias privalo suveikti, ne tik log'as");
  assert.equal(w.logs.some((line) => line.includes("discard-stale")), false, "terminaliniam task'ui discard-stale nebekartojama");
});

test("neatstatytas task failas per resume ESKALUOJAMAS", async () => {
  const w = world({
    checkpoint: { status: "finished", task_id: "0001", updated_at: NOW },
    locate: () => Promise.resolve("terminal-bucket"),
    accepted: true,
    relocate: () => Promise.resolve("absent"),
  });
  w.deps.integration = { ...w.deps.integration, restoreDoneCopy: () => Promise.resolve({ ok: false, detail: "istorijoje nėra" }) };

  await createWaveScheduler(w.deps).recoverFromCrash();
  assert.ok(w.logs.some((line) => line.includes("WAVE RESUME TASK ESCALATED")));
});

test("kiekvienas perskaičiavimas persistuoja snapshot'ą", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  await scheduler.nextTask();
  assert.ok(w.snapshots >= 1);
});
