// VQ-501 (1 dalis) testai — CLI registras ir task/queue komandų klasteris per fake portus:
// jokios realios FS, handler'iai grąžina exit kodus, o spausdintos eilutės perimamos per
// CliIo (etalono console išvestis 1:1).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { TaskGeneratePorts } from "../application/task-planning/generate.js";
import type { TaskStateStorePort } from "../application/task-execution/bucket-transition.js";
import {
  clearTaskLedgerEntry,
  syncTaskLedgerEntries,
  type TaskLedgerStorePort,
  type TaskLocation,
} from "../application/task-execution/task-ledger-service.js";
import type { TaskLedgerEntry } from "../application/task-execution/task-ledger-rules.js";
import type { BlockedTaskRoutingPorts } from "../application/task-execution/task-graph-import.js";
import type { TokenBudgetGatePorts } from "../application/token-governance/tool-budget-gates.js";
import { USAGE_ERROR_EXIT_CODE } from "../shared/exit-codes.js";
import {
  findCliCommand,
  renderCliCommandLine,
  renderCliCommandList,
  validateCliRegistry,
  type CliCommand,
  type CliIo,
} from "../interfaces/cli/registry.js";
import { parseTaskGenerateOptions, printTaskGenerate } from "../interfaces/cli/task-queue/task-generate.js";
import { moveTask } from "../interfaces/cli/task-queue/task-move.js";
import { requeueTask } from "../interfaces/cli/task-queue/requeue.js";
import { printTaskDependencies } from "../interfaces/cli/task-queue/task-dependencies.js";
import { taskLedgerSyncCommand } from "../interfaces/cli/task-queue/task-ledger-sync.js";
import { processQueuedTaskCommand } from "../interfaces/cli/task-queue/process-queued-task.js";

const ROOT = path.resolve("/repo");
const AG_ROOT = path.join(ROOT, "AG");
const abs = (rel: string): string => path.join(ROOT, rel).replace(/\\/g, "/");
const norm = (p: string): string => p.replace(/\\/g, "/");

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function makeGeneratePorts(files: Map<string, string>): TaskGeneratePorts {
  return {
    fs: {
      exists: async (p) => files.has(norm(p)),
      readTextFileIfExists: async (p) => files.get(norm(p)),
      listSubdirectories: async () => [],
      listFiles: async (dir) => {
        const prefix = `${norm(dir)}/`;
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map((key) => key.slice(prefix.length));
      },
      makeDirectory: async () => {},
      writeFileExclusive: async (p, content) => {
        if (files.has(norm(p))) return "exists";
        files.set(norm(p), content);
        return "created";
      },
    },
  };
}

type MoveCall = { from: string; toDir: string; taskName: string; updateCurrent: boolean | undefined };

function makeStore(calls: MoveCall[]): TaskStateStorePort {
  return {
    async moveTaskState(from, toDir, taskName, options) {
      calls.push({ from, toDir, taskName, updateCurrent: options?.updateCurrent });
      return path.join(toDir, taskName);
    },
    async finishTaskState(_from, toDir, taskName) {
      return path.join(toDir, taskName);
    },
    async activateTaskFile(_taskFile, activeFile) {
      return activeFile;
    },
  };
}

function makeLedgerStore(initial: Record<string, TaskLedgerEntry> | undefined): {
  store: TaskLedgerStorePort;
  written: Record<string, TaskLedgerEntry>[];
} {
  let current = initial;
  const written: Record<string, TaskLedgerEntry>[] = [];
  return {
    store: {
      exists: async () => current !== undefined,
      read: async () => ({ ...(current ?? {}) }),
      write: async (ledger) => {
        current = ledger;
        written.push(ledger);
      },
    },
    written,
  };
}

function makeBudgetPorts(): { ports: TokenBudgetGatePorts; resets: Record<string, unknown>[] } {
  const resets: Record<string, unknown>[] = [];
  return {
    ports: {
      fs: { readTextFileIfExists: async () => undefined },
      readTokenUsageLog: async () => "",
      readLlmCallResets: async () => ({}),
      writeLlmCallResets: async (value) => {
        resets.push(value);
      },
      writeBudgetStatus: async () => {},
      nowIso: () => "2026-08-20T12:00:00.000Z",
    },
    resets,
  };
}

test("registry: paieška, help eilutės ir invariantų validacija", () => {
  const commands: CliCommand[] = [
    { name: "task-move", usage: "<from-file> <to-dir>", description: "Move a task file", run: () => 0 },
    { name: "requeue", description: "Requeue a task", run: () => 0 },
  ];
  assert.equal(findCliCommand(commands, "requeue")?.description, "Requeue a task");
  assert.equal(findCliCommand(commands, "nesama"), undefined);
  assert.equal(renderCliCommandLine(commands[0]!), "task-move <from-file> <to-dir> — Move a task file");
  assert.deepEqual(renderCliCommandList(commands)[1], "requeue — Requeue a task");
  assert.deepEqual(validateCliRegistry(commands), []);
  assert.deepEqual(validateCliRegistry([...commands, { name: "requeue", description: "x", run: () => 0 }]), [
    "duplicate command name: requeue",
  ]);
  assert.deepEqual(validateCliRegistry([{ name: "  ", description: "x", run: () => 0 }]), [
    "command with empty name",
  ]);
});

test("parseTaskGenerateOptions: openspec/start formos ir klaidos 1:1", () => {
  assert.deepEqual(parseTaskGenerateOptions([]), { startIndex: 1 });
  assert.deepEqual(parseTaskGenerateOptions(["--openspec", "my-change"]), { startIndex: 1, openspecChangeId: "my-change" });
  assert.deepEqual(parseTaskGenerateOptions(["--change", "kitas"]), { startIndex: 1, openspecChangeId: "kitas" });
  assert.deepEqual(parseTaskGenerateOptions(["--openspec=x", "--start=7"]), { startIndex: 7, openspecChangeId: "x" });
  assert.deepEqual(parseTaskGenerateOptions(["--start", "3"]), { startIndex: 3 });
  assert.throws(() => parseTaskGenerateOptions(["--openspec"]), /--openspec requires a change id/);
  assert.throws(() => parseTaskGenerateOptions(["--start", "0"]), /--start requires a positive integer/);
  assert.throws(() => parseTaskGenerateOptions(["--start=ne"]), /--start requires a positive integer/);
  assert.throws(() => parseTaskGenerateOptions(["--kita"]), /Unknown flag/);
  assert.throws(() => parseTaskGenerateOptions(["pozicinis"]), /Unknown positional argument/);
});

test("printTaskGenerate: sėkmės išvestis 1:1 ir klaida → 2", async () => {
  const files = new Map<string, string>([
    [abs("AG/openspec/changes/my-change/spec.md"), "# Spec"],
    [abs("AG/openspec/changes/my-change/tasks.md"), "- [ ] Pirmas darbas\n"],
  ]);
  const ok = captureIo();
  const code = await printTaskGenerate(["--openspec", "my-change"], {
    ports: makeGeneratePorts(files),
    projectRoot: ROOT,
    runtimeRoot: path.join(ROOT, "vq"),
    io: ok.io,
  });
  assert.equal(code, 0);
  assert.equal(ok.out[0], "AG task generation ready: my-change");
  assert.equal(ok.out[2], "created: 1");
  assert.equal(ok.out[3], "skipped: 0");
  assert.ok(ok.out[4]?.startsWith("created: AG/tasks/queue/001-"));

  const fail = captureIo();
  const failCode = await printTaskGenerate(["--openspec", "nesamas"], {
    ports: makeGeneratePorts(new Map()),
    projectRoot: ROOT,
    io: fail.io,
  });
  assert.equal(failCode, 2);
  assert.match(fail.err[0] ?? "", /OpenSpec spec missing/);
});

test("moveTask: usage/ribų/bucket/failo vartai → 2; sėkmė deleguoja į store su updateCurrent:false", async () => {
  const calls: MoveCall[] = [];
  const deps = { store: makeStore(calls), isFile: async () => true, projectRoot: ROOT };

  const usage = captureIo();
  assert.equal(await moveTask([], { ...deps, io: usage.io }), 2);
  assert.equal(usage.err[0], "Usage: verqestra task-move <from-file> <to-dir>");

  const escape = captureIo();
  assert.equal(await moveTask(["../uz-ribos.md", "AG/tasks/queue"], { ...deps, io: escape.io }), 2);
  assert.match(escape.err[0] ?? "", /escapes project root/);

  const outsideBuckets = captureIo();
  assert.equal(await moveTask(["AG/tasks/queue/0001-a.md", "AG/tasks"], { ...deps, io: outsideBuckets.io }), 2);
  assert.match(outsideBuckets.err[0] ?? "", /task-move target must be a task bucket/);

  const unknownBucket = captureIo();
  assert.equal(await moveTask(["AG/tasks/queue/0001-a.md", "AG/tasks/nesamas"], { ...deps, io: unknownBucket.io }), 2);
  assert.match(unknownBucket.err[0] ?? "", /must be a task bucket/);

  const missing = captureIo();
  assert.equal(
    await moveTask(["AG/tasks/queue/0001-a.md", "AG/tasks/done"], { ...deps, isFile: async () => false, io: missing.io }),
    2,
  );
  assert.equal(missing.err[0], "task-move source must exist and be a file");
  assert.equal(calls.length, 0, "iki vartų praėjimo store nekviečiamas");

  const ok = captureIo();
  assert.equal(await moveTask(["AG/tasks/queue/0001-a.md", "AG/tasks/done"], { ...deps, io: ok.io }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.from, path.join(AG_ROOT, "tasks", "queue", "0001-a.md"));
  assert.equal(calls[0]!.toDir, path.join(AG_ROOT, "tasks", "done"));
  assert.equal(calls[0]!.taskName, "0001-a.md");
  assert.equal(calls[0]!.updateCurrent, false);
});

test("requeueTask: usage/ne-failas → 2; sėkmė — ledger clear + biudžeto reset + move į queue", async () => {
  const usage = captureIo();
  const budget = makeBudgetPorts();
  const ledger = makeLedgerStore({ "0013-api": { state: "human-review" } });
  const calls: MoveCall[] = [];
  const deps = {
    store: makeStore(calls),
    ledger: ledger.store,
    budget: budget.ports,
    isFile: async () => true,
    projectRoot: ROOT,
  };

  assert.equal(await requeueTask([], { ...deps, io: usage.io }), 2);
  assert.equal(usage.err.length, 4, "usage + 3 pavyzdžio eilutės");

  const missing = captureIo();
  assert.equal(await requeueTask(["0013-api.md"], { ...deps, isFile: async () => false, io: missing.io }), 2);
  assert.equal(missing.err[0], "Not found in human-review: 0013-api.md");

  const ok = captureIo();
  assert.equal(await requeueTask(["0013-api"], { ...deps, io: ok.io }), 0);
  assert.deepEqual(ok.out, ["requeued: 0013-api.md", "ledger cleared: 0013-api", "llm budget reset: 0013-api"]);
  assert.equal(ledger.written.length, 1);
  assert.ok(!("0013-api" in ledger.written[0]!), "įrašas realiai ištrintas");
  assert.equal(budget.resets.length, 1);
  assert.ok("0013-api" in budget.resets[0]!, "biudžeto reset žyma įrašyta task'ui");
  assert.equal(calls[0]!.toDir, path.join(AG_ROOT, "tasks", "queue"));

  // Įrašo nebuvimas — be "ledger cleared" eilutės (clearTaskLedgerEntry → false).
  const empty = makeLedgerStore({});
  const second = captureIo();
  assert.equal(await requeueTask(["0099-kitas.md"], { ...deps, ledger: empty.store, io: second.io }), 0);
  assert.deepEqual(second.out, ["requeued: 0099-kitas.md", "llm budget reset: 0099-kitas"]);
  assert.equal(await clearTaskLedgerEntry(makeLedgerStore(undefined).store, "bet-kas"), false);
});

test("printTaskDependencies: list/route-blocked keliai ir exit kodai 1:1", async () => {
  const queueTasks = [
    { file: "AG/tasks/queue/0002-dep.md", text: "# Task\n\n## Dependencies\n- blocked_by: 0001\n" },
    { file: "AG/tasks/queue/0003-free.md", text: "# Task\n" },
  ];
  const moved: string[] = [];
  const ports: BlockedTaskRoutingPorts = {
    listTasksInBucket: async (bucket) => (bucket === "queue" ? queueTasks : []),
    readTaskText: async (file) => queueTasks.find((task) => task.file === file)!.text,
    writeTaskText: async () => {},
    moveToHumanReview: async (file) => {
      moved.push(file);
      return file.replace("/queue/", "/human-review/");
    },
  };

  const list = captureIo();
  assert.equal(await printTaskDependencies([], { ports, io: list.io }), 0);
  assert.deepEqual(list.out, ["0002-dep: 0001", "0003-free: no-dependencies"]);

  const json = captureIo();
  assert.equal(await printTaskDependencies(["list", "--json"], { ports, io: json.io }), 0);
  assert.ok(json.out[0]?.startsWith("["));

  const routed = captureIo();
  assert.equal(await printTaskDependencies(["route-blocked", "0001"], { ports, io: routed.io }), 1);
  assert.equal(routed.out[0], "blocker: 0001");
  assert.equal(routed.out[2], "routed: 1");
  assert.deepEqual(moved, ["AG/tasks/queue/0002-dep.md"]);

  // Etalono elgesys: --json grąžina prieš signalinio kodo sprendimą → 0.
  const routedJson = captureIo();
  assert.equal(await printTaskDependencies(["route-blocked", "0001", "--json"], { ports, io: routedJson.io }), 0);

  const noBlocker = captureIo();
  assert.equal(await printTaskDependencies(["route-blocked"], { ports, io: noBlocker.io }), 2);
  assert.match(noBlocker.err[0] ?? "", /route-blocked <task-id>/);

  const unknown = captureIo();
  assert.equal(await printTaskDependencies(["kitas"], { ports, io: unknown.io }), 2);
});

test("task-ledger-sync: missing/cleared/synced/in-sync keliai ir grynos taisyklės", async () => {
  const listFiles = async (dir: string): Promise<string[]> => {
    const posix = norm(dir);
    if (posix.endsWith("/tasks/queue")) return ["0001-grazintas.md", "ne-taskas.txt"];
    if (posix.endsWith("/tasks/done")) return ["0002-baigtas.md"];
    return [];
  };

  const missing = captureIo();
  assert.equal(
    await taskLedgerSyncCommand({ ledger: makeLedgerStore(undefined).store, listFiles, agRoot: AG_ROOT, io: missing.io }),
    0,
  );
  assert.deepEqual(missing.out, ["task-ledger.json not found — nothing to sync"]);

  const ledger = makeLedgerStore({
    "0001-grazintas": { state: "human-review", file: "sena/vieta.md" },
    "0002-baigtas": { state: "active", file: "sena/kita.md" },
    "0009-dinges": { state: "done", file: "AG/tasks/done/0009-dinges.md" },
  });
  const sync = captureIo();
  assert.equal(
    await taskLedgerSyncCommand({
      ledger: ledger.store,
      listFiles,
      agRoot: AG_ROOT,
      io: sync.io,
      nowIso: () => "2026-08-20T12:00:00.000Z",
    }),
    0,
  );
  assert.deepEqual(sync.out, [
    "cleared (file back in queue): 0001-grazintas",
    "synced: 0002-baigtas -> done",
    "ledger updated: 2 entries",
  ]);
  const writtenLedger = ledger.written[0]!;
  assert.ok(!("0001-grazintas" in writtenLedger));
  assert.equal(writtenLedger["0002-baigtas"]?.state, "done");
  assert.equal(writtenLedger["0002-baigtas"]?.file, path.join(AG_ROOT, "tasks", "done", "0002-baigtas.md"));
  assert.equal(writtenLedger["0002-baigtas"]?.updated_at, "2026-08-20T12:00:00.000Z");
  assert.equal(writtenLedger["0009-dinges"]?.state, "done", "failo nesant įrašas paliekamas");

  const inSync = captureIo();
  assert.equal(
    await taskLedgerSyncCommand({ ledger: ledger.store, listFiles, agRoot: AG_ROOT, io: inSync.io }),
    0,
  );
  assert.deepEqual(inSync.out, ["ledger already in sync"]);

  // Gryna taisyklė: ta pati vieta be pokyčių — changed 0, ledger objektas naujas, bet lygus.
  const pure = syncTaskLedgerEntries(
    { "0002-baigtas": { state: "done", file: writtenLedger["0002-baigtas"].file } },
    new Map<string, TaskLocation>([
      ["0002-baigtas", { bucket: "done", file: writtenLedger["0002-baigtas"].file }],
    ]),
    "2026-08-20T13:00:00.000Z",
  );
  assert.equal(pure.changed, 0);
  assert.deepEqual(pure.log, []);
});

test("processQueuedTaskCommand: usage → USAGE_ERROR_EXIT_CODE, ok/fail → 0/1, ensureDirs prieš koordinatorių", async () => {
  const order: string[] = [];
  const usage = captureIo();
  assert.equal(
    await processQueuedTaskCommand([], {
      ensureDirs: async () => {},
      processQueuedTask: async () => true,
      io: usage.io,
    }),
    USAGE_ERROR_EXIT_CODE,
  );
  assert.equal(usage.err[0], "Usage: verqestra process-queued-task <task-file>");

  const seen: string[] = [];
  const okCode = await processQueuedTaskCommand(["AG/tasks/queue/0001-a.md"], {
    ensureDirs: async () => {
      order.push("dirs");
    },
    processQueuedTask: async (taskFile) => {
      order.push("run");
      seen.push(taskFile);
      return true;
    },
  });
  assert.equal(okCode, 0);
  assert.deepEqual(order, ["dirs", "run"]);
  assert.equal(seen[0], path.resolve("AG/tasks/queue/0001-a.md"), "reliatyvus kelias resolve'inamas prieš proceso cwd");

  const failCode = await processQueuedTaskCommand(["AG/tasks/queue/0001-a.md"], {
    ensureDirs: async () => {},
    processQueuedTask: async () => false,
  });
  assert.equal(failCode, 1);
});
