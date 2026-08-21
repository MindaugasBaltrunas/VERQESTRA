// VQ-504 (56/N) testai — galutinio audito remonto užduotis.
//
// Prikalama: pakartotinis išdavimas neleidžiamas, kol ankstesnė užduotis laukia žmogaus;
// infrastruktūros gedimas META (o ne tyliai virsta „human-review"); `done` pasiekiamas TIK tada,
// kai vartai po remonto praėjo.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FinalAuditRepairAlreadyPendingError,
  FinalAuditRepairInfrastructureError,
  isFinalAuditRepairTaskFile,
  processFinalAuditRepairTask,
  type FinalAuditRepairPorts,
} from "../application/quality-gates/final-audit-repair.js";

type World = {
  ports: FinalAuditRepairPorts;
  logs: string[];
  events: { to_state: string; reason: string }[];
  checkpoints: { status: string; phase: string }[];
  commands: string[][];
  moves: { state: string }[];
  stable: number;
};

function world(options: { pending?: string[]; dispatchCode?: number; qualityCode?: number; infraCodes?: number[] } = {}): World {
  const logs: string[] = [];
  const events: World["events"] = [];
  const checkpoints: World["checkpoints"] = [];
  const commands: string[][] = [];
  const moves: { state: string }[] = [];
  const state = { stable: 0 };
  const infra = new Set(options.infraCodes ?? [75]);

  const ports: FinalAuditRepairPorts = {
    pendingHumanReview: () => Promise.resolve(options.pending ?? []),
    writeTaskFile: (taskName) => Promise.resolve(`D:/repo/AG/tasks/error/${taskName}`),
    fingerprint: () => Promise.resolve("fp"),
    recordState: () => Promise.resolve(),
    recordCheckpoint: (checkpoint) => {
      checkpoints.push({ status: checkpoint.status, phase: checkpoint.phase });
      return Promise.resolve();
    },
    recordEvent: (event) => {
      events.push({ to_state: event.to_state, reason: event.reason });
      return Promise.resolve();
    },
    runCommand: (args) => {
      commands.push(args);
      return Promise.resolve(args[0] === "claude-dispatch" ? (options.dispatchCode ?? 0) : (options.qualityCode ?? 0));
    },
    moveTask: (fromFile, movedState, taskName) => {
      moves.push({ state: movedState });
      return Promise.resolve(`D:/repo/AG/tasks/${movedState}/${taskName}`);
    },
    markStable: () => {
      state.stable += 1;
      return Promise.resolve();
    },
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    isInfrastructureExitCode: (code) => infra.has(code),
    logFilePath: (name) => `D:/repo/vq/logs/${name}`,
  };

  return {
    ports,
    logs,
    events,
    checkpoints,
    commands,
    moves,
    get stable() {
      return state.stable;
    },
  };
}

test("remonto užduoties failas atpažįstamas ir su numeriu", () => {
  assert.equal(isFinalAuditRepairTaskFile("claude-audit-repair.md"), true);
  assert.equal(isFinalAuditRepairTaskFile("claude-audit-repair-2.md"), true);
  assert.equal(isFinalAuditRepairTaskFile("claude-audit-repair-notes.md"), false);
  assert.equal(isFinalAuditRepairTaskFile("0042.md"), false);
});

test("jau laukianti užduotis naujos NEIŠDUODA", async () => {
  const w = world({ pending: ["claude-audit-repair.md"] });
  await assert.rejects(() => processFinalAuditRepairTask(w.ports, "# repair"), FinalAuditRepairAlreadyPendingError);

  // Kitaip kiekvienas ratas gamintų po kopiją, o žmogus rastų dešimt tų pačių užduočių.
  assert.deepEqual(w.commands, []);
  assert.deepEqual(w.moves, []);
});

test("praėję vartai po remonto duoda `done` ir stabilią žymę", async () => {
  const w = world();
  const result = await processFinalAuditRepairTask(w.ports, "# repair");

  assert.equal(result.state, "done");
  assert.deepEqual(
    w.commands.map((args) => args[0]),
    ["claude-dispatch", "quality-gates"],
  );
  assert.equal(w.stable, 1);
  assert.ok(w.events.some((event) => event.reason === "final_audit_repair_done"));
});

test("kritę vartai siunčia užduotį ŽMOGUI, o ne uždaro kaip padarytą", async () => {
  const w = world({ qualityCode: 1 });
  const result = await processFinalAuditRepairTask(w.ports, "# repair");

  assert.equal(result.state, "human-review");
  assert.equal(w.stable, 0, "stabili žymė statoma tik po tikrai praėjusio audito");
  assert.ok(w.events.some((event) => event.reason === "final_audit_repair_failed"));
});

test("nepavykęs dispatch'as vartų NEPALEIDŽIA", async () => {
  const w = world({ dispatchCode: 1 });
  const result = await processFinalAuditRepairTask(w.ports, "# repair");

  // Be remonto vartai duotų tą patį raudoną verdiktą, o jo pakartojimas nieko nepasakytų.
  assert.deepEqual(
    w.commands.map((args) => args[0]),
    ["claude-dispatch"],
  );
  assert.equal(result.qualityCode, 1);
  assert.equal(result.state, "human-review");
});

test("infrastruktūros kodas META ir palieka `failed` checkpoint'ą", async () => {
  const w = world({ dispatchCode: 75 });
  await assert.rejects(() => processFinalAuditRepairTask(w.ports, "# repair"), FinalAuditRepairInfrastructureError);

  // Aplinkos gedimas nėra remonto rezultatas: jo užvertimas kaip baigties paslėptų priežastį.
  assert.deepEqual(w.moves, []);
  assert.ok(w.checkpoints.some((entry) => entry.status === "failed"));
  assert.ok(w.events.some((event) => event.reason.startsWith("infra_abort stage=dispatch")));
});

test("infrastruktūros kodas VARTUOSE irgi meta", async () => {
  const w = world({ qualityCode: 75 });
  await assert.rejects(() => processFinalAuditRepairTask(w.ports, "# repair"), FinalAuditRepairInfrastructureError);
  assert.ok(w.events.some((event) => event.reason.startsWith("infra_abort stage=quality-gates")));
});
