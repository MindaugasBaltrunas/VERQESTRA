// VQ-504 (51/N) testai — slot'o vykdytojas.
//
// Prikalama nuosavybės tvarka (kiekvienas vartas fail-closed ir ĮVARDINTAS), tai, kad lease
// atlaisvinamas po KIEKVIENOS baigties, ir vaiko aplinkos valymas: claim raktai vaikui
// neperduodami niekada, o tapatybė injektuojama, ne paveldima.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChildEnvironment,
  createSlotTaskRunner,
  type SlotTaskRunnerPorts,
  type SlotTaskRunnerSlot,
} from "../application/scheduling/slot-task-runner.js";
import { createWorkerLease } from "../application/scheduling/worker-lease-store.js";
import { LEASE_ENV } from "../application/scheduling/worker-lease-runtime.js";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function lease(overrides: { taskId?: string; workerId?: string; status?: "held" | "released" } = {}): WorkerLease {
  const base = createWorkerLease(
    {
      owner_id: "loop-1",
      run_id: "r1",
      worker_id: overrides.workerId ?? "w2",
      task_id: overrides.taskId ?? "0042",
      attempt: 1,
    },
    { now: NOW, fencingToken: 7, leaseId: "lease-1" },
  );
  return overrides.status === "released" ? { ...base, status: "released" } : base;
}

function slot(overrides: Partial<SlotTaskRunnerSlot> = {}): SlotTaskRunnerSlot {
  return {
    worker_id: "w2",
    task_id: "0042",
    file: "AG/tasks/active/0042.md",
    absoluteFile: "D:/repo/AG/tasks/active/0042.md",
    worktree_path: ".worktrees/w2",
    lease_id: "lease-1",
    ...overrides,
  };
}

/** Pirminis slot'as: be kopijos ir be lease — abu laukai pašalinami, ne paverčiami `undefined`. */
function primarySlot(): SlotTaskRunnerSlot {
  const { worktree_path: _copy, lease_id: _lease, ...rest } = slot();
  return rest;
}

type World = {
  ports: SlotTaskRunnerPorts;
  logs: string[];
  calls: { inProcess: number; child: number; prepared: number; released: number; heartbeats: number; ensured: number };
};

function world(overrides: Partial<SlotTaskRunnerPorts> = {}): World {
  const logs: string[] = [];
  const calls = { inProcess: 0, child: 0, prepared: 0, released: 0, heartbeats: 0, ensured: 0 };
  const ports: SlotTaskRunnerPorts = {
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    runInProcess: () => {
      calls.inProcess += 1;
      return Promise.resolve(true);
    },
    runChild: () => {
      calls.child += 1;
      return Promise.resolve(true);
    },
    resolveWorktree: (relative) => `D:/repo/${relative}`,
    readLease: () => Promise.resolve(lease()),
    heartbeat: () => {
      calls.heartbeats += 1;
      return Promise.resolve({ status: "ok" });
    },
    release: () => {
      calls.released += 1;
      return Promise.resolve({ status: "ok" });
    },
    prepareWorktree: () => {
      calls.prepared += 1;
      return Promise.resolve();
    },
    // Numatytasis vartas praneša „failas kopijoje yra" — visi seni testai lieka apie tai, apie ką buvo.
    ensureTaskFileInWorktree: () => {
      calls.ensured += 1;
      return Promise.resolve({ status: "ok" });
    },
    ...overrides,
  };
  return { ports, logs, calls };
}

test("pirminis slot'as eina IN-PROCESS keliu be lease žingsnių", async () => {
  const w = world();
  const ok = await createSlotTaskRunner(w.ports)(primarySlot());

  assert.equal(ok, true);
  assert.equal(w.calls.inProcess, 1);
  assert.equal(w.calls.child, 0);
  assert.equal(w.calls.heartbeats, 0, "pirminiam slot'ui nuosavybės klausimo nėra");
  assert.equal(w.calls.released, 0);
});

test("neperskaitomas lease store NĖRA „lease nėra“", async () => {
  const w = world({ readLease: () => Promise.reject(new Error("EIO")) });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, false);
  assert.equal(w.calls.child, 0);
  assert.ok(w.logs[0]?.includes("lease store neperskaitomas"));
});

test("nesutampantis `lease_id` vaiko NEPALEIDŽIA", async () => {
  const w = world();
  const ok = await createSlotTaskRunner(w.ports)(slot({ lease_id: "kitas" }));

  assert.equal(ok, false);
  assert.ok(w.logs[0]?.includes("lease_id mismatch"));
});

test("svetimo task'o lease atmetamas TIKSLIU palyginimu", async () => {
  const w = world({ readLease: () => Promise.resolve(lease({ taskId: "0043" })) });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, false);
  assert.ok(w.logs[0]?.includes("lease-task-mismatch"));
});

test("atlaisvintas lease vaiko neleidžia", async () => {
  const w = world({ readLease: () => Promise.resolve(lease({ status: "released" })) });
  assert.equal(await createSlotTaskRunner(w.ports)(slot()), false);
  assert.ok(w.logs[0]?.includes("status=released"));
});

test("heartbeat'o atsisakymas sustabdo PRIEŠ bootstrap'ą", async () => {
  const w = world({ heartbeat: () => Promise.resolve({ status: "denied", reason: "foreign-lease" }) });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, false);
  assert.equal(w.calls.prepared, 0, "kopija neruošiama be nuosavybės");
  assert.ok(w.logs[0]?.includes("heartbeat denied: foreign-lease"));
});

test("bootstrap'o klaida yra `ok=false`, o ne metimas", async () => {
  const w = world({ prepareWorktree: () => Promise.reject(new Error("dist nerastas")) });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  // Metimas nutrauktų visą bangą, nors kitas lane'as dirba nepriklausomai.
  assert.equal(ok, false);
  assert.equal(w.calls.child, 0);
  assert.ok(w.logs.some((line) => line.includes("worktree runtime bootstrap nepavyko: dist nerastas")));
  assert.equal(w.calls.released, 1, "lease atlaisvinamas ir po bootstrap klaidos");
});

test("task failo vartai: portas praneša „yra“ — vaikas paleidžiamas kaip iki šiol", async () => {
  const seen: Array<{ taskId: string; worktreeAbs: string }> = [];
  const w = world({
    ensureTaskFileInWorktree: (slot, worktreeAbs) => {
      seen.push({ taskId: slot.task_id, worktreeAbs });
      return Promise.resolve({ status: "ok" });
    },
  });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, true);
  assert.equal(w.calls.child, 1);
  // Vartai gauna TĄ PATĮ kopijos kelią, kurį gaus vaikas — kitaip jie tikrintų kitą medį.
  assert.deepEqual(seen, [{ taskId: "0042", worktreeAbs: "D:/repo/.worktrees/w2" }]);
});

test("task failo NĖRA kopijoje: atkūrimas uždaro lenktynes BE `task-failed` kelio", async () => {
  // FS↔git lenktynės: planuoklė task'ą pačiumpa nuo disko, kopija gimsta iš HEAD be to commit'o.
  // Verdiktas (a): vartai failą atkuria iš `slot.absoluteFile` ir praneša `ok`.
  const restored: string[] = [];
  const w = world({
    ensureTaskFileInWorktree: (slot) => {
      restored.push(slot.absoluteFile);
      return Promise.resolve({ status: "ok" });
    },
  });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, true, "`false` čia reikštų `task-failed` parką už aprūpinimo klaidą");
  assert.equal(w.calls.child, 1);
  assert.deepEqual(restored, ["D:/repo/AG/tasks/active/0042.md"]);
  assert.equal(
    w.logs.some((line) => line.includes("WAVE SLOT FAILED")),
    false,
    "uždarytos lenktynės nepalieka nė vienos nesėkmės eilutės",
  );
});

test("task failo nėra NIEKUR: vaikas NEPALEIDŽIAMAS, o priežastis ĮVARDIJAMA", async () => {
  const w = world({
    ensureTaskFileInWorktree: () => Promise.resolve({ status: "missing", reason: "šaltinio nėra pirminiame medyje" }),
  });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, false);
  assert.equal(w.calls.child, 0, "ENOENT vaike duotų exit 74 ir melagingą diagnozę");
  assert.equal(w.calls.prepared, 0, "vartai pigūs — bootstrap'as už jų");
  assert.ok(w.logs[0]?.includes("task-file-missing: šaltinio nėra pirminiame medyje"));
  assert.equal(w.calls.released, 1, "lease atlaisvinamas ir po varto atsisakymo");
});

test("task failo vartų metimas bangos nenutraukia", async () => {
  const w = world({ ensureTaskFileInWorktree: () => Promise.reject(new Error("EPERM")) });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, false);
  assert.equal(w.calls.child, 0);
  assert.ok(w.logs[0]?.includes("task-file-missing: vartai krito: EPERM"));
});

test("pirminis slot'as task failo vartų NEKVIEČIA", async () => {
  const w = world();
  assert.equal(await createSlotTaskRunner(w.ports)(primarySlot()), true);

  // In-process kelias dirba pirminiame medyje — ten failas yra pagal apibrėžimą.
  assert.equal(w.calls.ensured, 0);
  assert.equal(w.calls.inProcess, 1);
});

test("nepririštas task failo portas naujos gedimo klasės nesukuria", async () => {
  const w = world();
  const { ensureTaskFileInWorktree: _unbound, ...withoutPort } = w.ports;
  const ok = await createSlotTaskRunner(withoutPort)(slot());

  assert.equal(ok, true);
  assert.equal(w.calls.child, 1);
});

test("lease atlaisvinamas po KIEKVIENOS baigties", async () => {
  const success = world();
  await createSlotTaskRunner(success.ports)(slot());
  assert.equal(success.calls.released, 1);

  const failure = world({ runChild: () => Promise.resolve(false) });
  assert.equal(await createSlotTaskRunner(failure.ports)(slot()), false);
  assert.equal(failure.calls.released, 1);
});

test("atlaisvinimo nesėkmė vaiko rezultato NEUŽDENGIA", async () => {
  const w = world({ release: () => Promise.reject(new Error("store užrakintas")) });
  const ok = await createSlotTaskRunner(w.ports)(slot());

  assert.equal(ok, true, "vaikas pavyko — atlaisvinimo klaida to nekeičia");
  assert.ok(w.logs.some((line) => line.includes("LEASE RELEASE FAILED")));
});

test("atsisakytas atlaisvinimas ĮVARDIJAMAS", async () => {
  const w = world({ release: () => Promise.resolve({ status: "denied", reason: "stale-token" }) });
  await createSlotTaskRunner(w.ports)(slot());
  assert.ok(w.logs.some((line) => line.includes("LEASE RELEASE DENIED") && line.includes("stale-token")));
});

test("vaiko aplinka NETURI nė vieno claim rakto", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    [LEASE_ENV.leaseId]: "lease-1",
    [LEASE_ENV.fencingToken]: "7",
    AG_RUN_ID: "senas-run",
    AG_DISPATCH_NONCE: "svetimas",
    AG_RUNTIME_ARTIFACTS: "1",
    CLAUDE_PROJECT_DIR: "D:/repo",
  };
  const env = buildChildEnvironment(base, "CLAUDE_PROJECT_DIR", "D:/repo/.worktrees/w2");

  for (const key of Object.values(LEASE_ENV)) assert.equal(env[key], undefined);
  assert.equal(env["AG_RUN_ID"], undefined, "paveldėtas run id perimtų vaiko attempt namespace'ą");
  assert.equal(env["AG_DISPATCH_NONCE"], undefined, "svetimas nonce nutekėtų į vaiko stop-evidence");
  // Konfigo jungiklis lieka: vaikas veikia tais pačiais nustatymais kaip tėvas.
  assert.equal(env["AG_RUNTIME_ARTIFACTS"], "1");
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["CLAUDE_PROJECT_DIR"], "D:/repo/.worktrees/w2");
});

test("tapatybė INJEKTUOJAMA, ne paveldima", () => {
  const env = buildChildEnvironment({ AG_RUN_ID: "senas" }, "CLAUDE_PROJECT_DIR", "D:/wt", {
    runId: "r2",
    workerId: "w2",
    taskId: "0042",
    attemptId: "a3",
  });
  assert.equal(env["AG_RUN_ID"], "r2");
  assert.equal(env["AG_WORKER_ID"], "w2");
  assert.equal(env["AG_ATTEMPT_ID"], "a3");
});
