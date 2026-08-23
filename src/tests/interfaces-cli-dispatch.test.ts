// VQ-501 (2/5-a) testai — dispatch klasterio lengvosios komandos per fake portus + jų
// application taisyklės: loop-preconditions vartai ir retry skaitiklių mutacija.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  evaluateLoopPreconditions,
  isStaleIndexLock,
  loopPreconditionsOk,
  productTreeDirtyEntries,
  renderLoopPreconditionReport,
  type LoopPreconditionPorts,
} from "../application/scheduling/loop-preconditions.js";
import {
  applyRetryCountUpdate,
  incrementTaskRetryCount,
  type RetryCountsStorePort,
} from "../application/task-execution/retry-counts.js";
import { defaultAgentPolicy } from "../domain/policies/agent-policy-defaults.js";
import type { ExecutionAdapter, ExecutionAdapterKind, ExecutionResult } from "../domain/agents/execution-port.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { dispatch, printDispatch, type ExecutionDispatchResult } from "../interfaces/cli/dispatch/dispatch.js";
import { printCodexDispatch } from "../interfaces/cli/dispatch/codex-dispatch.js";
import { onStopBridge } from "../interfaces/cli/dispatch/on-stop-bridge.js";
import { loopGuard } from "../interfaces/cli/dispatch/loop-guard.js";
import { retryGuard, type RetryGuardCommandDeps } from "../interfaces/cli/dispatch/retry-guard.js";

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// loop-preconditions
// ---------------------------------------------------------------------------

const GREEN_PORTS: LoopPreconditionPorts = {
  isGitRepository: async () => true,
  gitStatusPorcelain: async () => ({ code: 0, stdout: "" }),
  resolveGitDir: async (root) => path.join(root, ".git"),
  fileMtimeMs: async () => undefined,
  readTextFileIfExists: async () => "abc123def456\n",
  gitCommitExists: async () => true,
  findStaleDistFiles: async () => [],
};

test("loop-preconditions: ne-repo trumpina, žali vartai OK, higienos klaida — note, ne blokas", async () => {
  const notRepo = await evaluateLoopPreconditions(
    { ...GREEN_PORTS, isGitRepository: async () => false },
    "/repo",
    "/repo/orch",
    "/repo/vq/state",
  );
  assert.equal(notRepo.ok, false);
  assert.equal(notRepo.checks.length, 1, "ne-repo atveju kiti vartai nevykdomi");

  const green = await evaluateLoopPreconditions(GREEN_PORTS, "/repo", "/repo/orch", "/repo/vq/state", 1_000_000, {
    reapDeadLeases: async () => ["LEASE REAPED: w2"],
  });
  assert.equal(green.ok, true);
  assert.deepEqual(green.notes, ["LEASE REAPED: w2"]);
  assert.deepEqual(
    green.checks.map((check) => check.name),
    ["git-repository", "fresh-dist", "clean-tree", "no-stale-index-lock", "valid-stable-ref"],
  );

  const reaperBoom = await evaluateLoopPreconditions(GREEN_PORTS, "/repo", "/repo/orch", "/repo/vq/state", 1_000_000, {
    reapDeadLeases: async () => {
      throw new Error("sprogo");
    },
  });
  assert.equal(reaperBoom.ok, true, "higienos metimas niekada neblokuoja starto");
  assert.deepEqual(reaperBoom.notes, ["LEASE REAP FAILED: sprogo"]);
});

test("loop-preconditions: dirty produkto medis, stale index.lock ir stable-ref blokai; runtime keliai filtruojami", async () => {
  // Produkto failas blokuoja; vq runtime įrašas — ne (domain nonRuntimeDirtyEntriesFromStatus).
  const dirtyEntries = await productTreeDirtyEntries(
    { gitStatusPorcelain: async () => ({ code: 0, stdout: " M src/app.ts\n?? vq/state/x.json\n" }) },
    "/repo",
  );
  assert.deepEqual(dirtyEntries, [{ status: " M", path: "src/app.ts" }]);
  const gitFailed = await productTreeDirtyEntries({ gitStatusPorcelain: async () => ({ code: 128, stdout: "" }) }, "/repo");
  assert.deepEqual(gitFailed, [{ status: "!!", path: "<git status failed>" }]);

  const now = 10_000_000;
  assert.equal(isStaleIndexLock(now - 60_000, now), true);
  assert.equal(isStaleIndexLock(now - 59_000, now), false);

  const blocked = await evaluateLoopPreconditions(
    {
      ...GREEN_PORTS,
      gitStatusPorcelain: async () => ({ code: 0, stdout: " M src/app.ts\n" }),
      fileMtimeMs: async () => now - 120_000,
      readTextFileIfExists: async () => undefined,
    },
    "/repo",
    "/repo/orch",
    "/repo/vq/state",
    now,
  );
  assert.equal(blocked.ok, false);
  const byName = new Map(blocked.checks.map((check) => [check.name, check]));
  assert.equal(byName.get("clean-tree")?.ok, false);
  assert.match(byName.get("clean-tree")?.detail ?? "", /1 uncommitted product file/);
  assert.equal(byName.get("no-stale-index-lock")?.ok, false);
  assert.match(byName.get("no-stale-index-lock")?.detail ?? "", /stale .*index\.lock \(age 120s\)/);
  assert.equal(byName.get("valid-stable-ref")?.ok, false);

  // Šviežias lock'as nepakelia bloko, tik detalę.
  const freshLock = await evaluateLoopPreconditions(
    { ...GREEN_PORTS, fileMtimeMs: async () => now - 1_000 },
    "/repo",
    "/repo/orch",
    "/repo/vq/state",
    now,
  );
  assert.equal(freshLock.ok, true);
  assert.match(
    freshLock.checks.find((check) => check.name === "no-stale-index-lock")?.detail ?? "",
    /present but fresh/,
  );

  const lines = renderLoopPreconditionReport(blocked);
  assert.equal(lines.at(-1), "AG_LOOP_PRECONDITIONS_BLOCKED");
  assert.ok(lines.some((line) => line.startsWith("BLOCK clean-tree:")));
  assert.ok(lines.some((line) => line.trim().startsWith("fix:")));
  assert.equal(renderLoopPreconditionReport(await evaluateLoopPreconditions(GREEN_PORTS, "/r", "/o", "/s")).at(-1), "AG_LOOP_PRECONDITIONS_OK");
  assert.equal(loopPreconditionsOk(blocked.checks), false);
});

// ---------------------------------------------------------------------------
// retry-counts
// ---------------------------------------------------------------------------

test("retry-counts: legacy raktų migracija, max taisyklė ir store round-trip", async () => {
  const counts: Record<string, number> = { "0042": 2, "0042:senas-err": 1, "error:kitas": 5 };
  const update = applyRetryCountUpdate(counts, "0042", "type-error");
  // Legacy suma 3 > esamas task:0042 (0) → taskCount = 3 + 1.
  assert.deepEqual(update, { taskKey: "task:0042", errorKey: "error:type-error", taskCount: 4, errorCount: 1 });
  assert.ok(!("0042" in counts) && !("0042:senas-err" in counts), "legacy raktai pašalinti");
  assert.equal(counts["task:0042"], 4);

  let persisted: Record<string, number> = { "task:0042": 4 };
  // `update` yra vienas serializuotas read-modify-write (2026-08-23): fixture'as jį atkartoja
  // tiksliai — perskaito kopiją, leidžia mutaciją, persist'ina.
  const store: RetryCountsStorePort = {
    read: async () => ({ ...persisted }),
    update: async (mutate) => {
      const counts = { ...persisted };
      const result = mutate(counts);
      persisted = counts;
      return result;
    },
  };
  const second = await incrementTaskRetryCount(store, "0042", "type-error");
  assert.equal(second.taskCount, 5);
  assert.equal(persisted["error:type-error"], 1);
});

// ---------------------------------------------------------------------------
// dispatch / codex-dispatch
// ---------------------------------------------------------------------------

function fakeAdapter(kind: ExecutionAdapterKind, result: Partial<ExecutionResult> = {}): ExecutionAdapter {
  return {
    kind,
    execute: async () => ({
      adapter: kind,
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      reason: `${kind}_completed`,
      ...result,
    }),
  };
}

test("dispatch: usage → 2, dry-run sėkmė → 0, parked claude gauna DUP-09 guidance ir → 1", async () => {
  const created: string[] = [];
  const runResults = new Map<string, ExecutionDispatchResult>([
    ["dry-run", { adapter: "dry-run", status: "completed", task_id: "0001-a", summary: "dry_run_completed", result_path: "vq/state/r.json" }],
    ["claude", { adapter: "claude", status: "failed", task_id: "0001-a", summary: "claude_adapter_not_implemented", result_path: "" }],
  ]);
  const deps = {
    readTaskText: async () => "# Task\n",
    loadAgentPolicy: async () => defaultAgentPolicy,
    createAdapter: (kind: ExecutionAdapterKind) => {
      created.push(kind);
      return fakeAdapter(kind);
    },
    runDispatch: async (_taskFile: string, adapter: ExecutionAdapter) => runResults.get(adapter.kind)!,
  };

  const usage = captureIo();
  assert.equal(await printDispatch([], { ...deps, io: usage.io }), 2);
  assert.match(usage.err[0] ?? "", /Usage: verqestra dispatch <task-file>/);

  const ok = captureIo();
  assert.equal(await printDispatch(["AG/tasks/queue/0001-a.md"], { ...deps, io: ok.io }), 0);
  assert.deepEqual(created, ["dry-run"], "be --adapter default'as dry-run");
  assert.equal(ok.out[0], "dispatch: completed");

  const parked = await dispatch(["AG/tasks/queue/0001-a.md", "--adapter=claude"], deps);
  assert.match(parked.summary, /claude_adapter_not_implemented: adapter 'claude' is parked\/reference only \(DUP-09\)/);
  assert.match(parked.summary, /use 'verqestra claude-dispatch <task-file>'/);
  const parkedPrint = captureIo();
  assert.equal(await printDispatch(["AG/tasks/queue/0001-a.md", "--adapter=claude"], { ...deps, io: parkedPrint.io }), 1);
});

test("codex-dispatch: ne-codex → dry-run kelias; codex be context-pack → 2; codex kelias įjungia adapterį", async () => {
  const calls: Array<{ kind: ExecutionAdapterKind; enabled: boolean | undefined }> = [];
  const deps = {
    createAdapter: (kind: ExecutionAdapterKind, options?: { enabled?: boolean }) => {
      calls.push({ kind, enabled: options?.enabled });
      return fakeAdapter(kind, { exitCode: kind === "codex" ? 0 : 3, reason: `${kind}_done` });
    },
    readContextPack: async () => ({ task_id: "0007" }),
    resolvePath: (candidate: string) => `/abs/${candidate}`,
    cwd: () => "/repo",
  };

  const dry = captureIo();
  assert.equal(await printCodexDispatch(["0007"], { ...deps, io: dry.io }), 3);
  assert.deepEqual(calls[0], { kind: "dry-run", enabled: undefined });

  const noPack = captureIo();
  assert.equal(await printCodexDispatch(["0007", "--adapter=codex"], { ...deps, io: noPack.io }), 2);
  assert.match(noPack.err[0] ?? "", /--context-pack=<file>/);

  const okIo = captureIo();
  assert.equal(await printCodexDispatch(["0007", "--adapter=codex", "--context-pack=cp.json"], { ...deps, io: okIo.io }), 0);
  assert.deepEqual(calls.at(-1), { kind: "codex", enabled: true });
  assert.equal(okIo.out[1], "status: completed");

  const broken = captureIo();
  assert.equal(
    await printCodexDispatch(["0007", "--adapter=codex", "--context-pack=cp.json"], {
      ...deps,
      readContextPack: async () => {
        throw new Error("bad json");
      },
      io: broken.io,
    }),
    2,
  );
  assert.equal(broken.err[0], "bad json");
});

// ---------------------------------------------------------------------------
// on-stop-bridge / loop-guard / retry-guard
// ---------------------------------------------------------------------------

test("on-stop-bridge: argv default'ai ir taskId iš current-task-id keliauja į no-clobber rašytoją", async () => {
  const writes: Array<{ status: string; reason: string; taskId: string }> = [];
  const deps = {
    readCurrentTaskId: async () => "0042-x",
    writeStopBridge: async (status: string, reason: string, taskId: string) => {
      writes.push({ status, reason, taskId });
    },
  };
  assert.equal(await onStopBridge(["done", "committed"], deps), 0);
  assert.equal(await onStopBridge([], { ...deps, readCurrentTaskId: async () => "" }), 0);
  assert.deepEqual(writes, [
    { status: "done", reason: "committed", taskId: "0042-x" },
    { status: "unknown", reason: "", taskId: "" },
  ]);
});

test("loop-guard: ensureDirs prieš vartus, render eilutės, exit 0/1 pagal report.ok", async () => {
  const order: string[] = [];
  const okIo = captureIo();
  const code = await loopGuard({
    ensureDirs: async () => {
      order.push("dirs");
    },
    evaluate: async () => {
      order.push("evaluate");
      return { ok: true, checks: [{ name: "git-repository", ok: true, severity: "block", detail: "ok" }], notes: ["N1"] };
    },
    io: okIo.io,
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ["dirs", "evaluate"]);
  assert.deepEqual(okIo.out, ["NOTE  N1", "OK    git-repository: ok", "AG_LOOP_PRECONDITIONS_OK"]);

  const blockedIo = captureIo();
  assert.equal(
    await loopGuard({
      ensureDirs: async () => {},
      evaluate: async () => ({ ok: false, checks: [], notes: [] }),
      io: blockedIo.io,
    }),
    1,
  );
});

function retryGuardDeps(overrides: Partial<RetryGuardCommandDeps> = {}): {
  deps: RetryGuardCommandDeps;
  agLines: string[];
  errorLogs: string[];
  counts: Record<string, number>;
  signatures: Record<string, string>[];
  legacy: string[];
} {
  const agLines: string[] = [];
  const errorLogs: string[] = [];
  let counts: Record<string, number> = {};
  const signatures: Record<string, string>[] = [];
  const legacy: string[] = [];
  const deps: RetryGuardCommandDeps = {
    ensureDirs: async () => {},
    readDecision: async () => ({ verdict: "repair", task_id: "0042", retry_key: "type-error" }),
    counts: {
      read: async () => ({ ...counts }),
      update: async (mutate) => {
        const next = { ...counts };
        const result = mutate(next);
        counts = next;
        return result;
      },
    },
    maxRetriesPerError: async () => 3,
    readCurrentTaskId: async () => undefined,
    readErrorSignatures: async () => ({}),
    writeErrorSignatures: async (value) => {
      signatures.push(value);
    },
    writeLegacyErrorSignature: async (text) => {
      legacy.push(text);
    },
    agLog: async (line) => {
      agLines.push(line);
    },
    appendErrorLog: async (text) => {
      errorLogs.push(text);
    },
    now: () => new Date("2026-08-20T12:00:00.000Z"),
    ...overrides,
  };
  return { deps, agLines, errorLogs, counts, signatures, legacy };
}

test("retry-guard: ne-repair skip, trūkstamas taskId → 1, skaitiklis+parašai+log, limitas → 1", async () => {
  const skipped = retryGuardDeps({ readDecision: async () => ({}) });
  assert.equal(await retryGuard([], skipped.deps), 0);
  assert.match(skipped.agLines[0] ?? "", /RETRY GUARD SKIPPED: verdict=<missing-or-corrupted-decision>/);

  const noTask = retryGuardDeps({ readDecision: async () => ({ verdict: "repair" }) });
  assert.equal(await retryGuard([], noTask.deps), 1);
  assert.match(noTask.errorLogs[0] ?? "", /RETRY GUARD MISSING TASK ID/);

  const first = retryGuardDeps();
  assert.equal(await retryGuard([], first.deps), 0, "pirmas repair (count 1 < max 3) leidžiamas");
  assert.match(first.agLines[0] ?? "", /^RETRY: task=0042 task_count=1 retry_key=type-error error_count=1 max=3 remaining=2$/);
  assert.deepEqual(first.signatures[0], { "0042": "type-error" });
  assert.deepEqual(first.legacy, ["type-error\n"]);

  // --task-id laimi prieš decision.task_id; error_signature — atsarginis retry_key.
  const flagged = retryGuardDeps({
    readDecision: async () => ({ verdict: "repair", task_id: "kitas", error_signature: "sig-x" }),
  });
  assert.equal(await retryGuard(["--task-id", "0099"], flagged.deps), 0);
  assert.match(flagged.agLines[0] ?? "", /task=0099 .*retry_key=sig-x/);

  const limited = retryGuardDeps();
  await limited.deps.counts.update((counts) => {
    counts["task:0042"] = 2;
  });
  await retryGuard([], limited.deps);
  assert.equal(await retryGuard([], limited.deps), 1, "trečias dispatch'as pasiekia max=3");
  assert.match(limited.errorLogs[0] ?? "", /MAX RETRIES REACHED/);
  assert.match(limited.errorLogs[0] ?? "", /routing=human-review-after-rollback/);
});
