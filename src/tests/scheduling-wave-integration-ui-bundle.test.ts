// 161: po sėkmingo suliejimo, kai `ui-app/src` paliestas, žingsnis perstato UI bundle'ą.
// Nesėkmė ČIA niekada neparkuoja — bundle'as yra stebėjimo paviršius, ne vartas.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createIntegrationStepRunner } from "../application/scheduling/wave-integration-step.js";
import type { WaveIntegrationPorts } from "../application/scheduling/wave-integration-ports.js";
import type { WorkerIntegrationStep } from "../application/scheduling/worker-integration.js";
import { createWorkerLease } from "../application/scheduling/worker-lease-store.js";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

function lease(taskId: string, workerId: string): WorkerLease {
  return createWorkerLease(
    { owner_id: "loop-1", run_id: "r1", worker_id: workerId, task_id: taskId, attempt: 1 },
    { now: NOW, fencingToken: 1, worktreePath: `.worktrees/${workerId}` },
  );
}

const STEP: WorkerIntegrationStep = {
  worker_id: "w1",
  worker_index: 1,
  task_id: "0161",
  file: "AG/tasks/active/0161.md",
  attempt: 1,
  worktree_path: ".worktrees/w1",
  lease: lease("0161", "w1"),
};

type BaseOptions = { touchedUiSrc?: boolean; rebuildUiBundleOk?: boolean };

function basePorts(options: BaseOptions, calls: { rebuildUiBundle: number }, logs: string[], events: string[]) {
  const base: Omit<WaveIntegrationPorts, "integrationTouchedUiSrc" | "rebuildUiBundle"> = {
    runId: "r1",
    waveContext: () => ({ waveId: "w1", graphHash: "h" }),
    safeLog: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    safeEvent: (event) => {
      events.push(event.event);
      return Promise.resolve();
    },
    resolveWorktreeLayout: (identity) => ({ relativePath: `.worktrees/${identity.worker_id}`, branch: `ag/${identity.task_id}` }),
    locateTask: () => Promise.resolve("terminal-bucket"),
    resolvePrimaryHead: () => Promise.resolve("headbefore"),
    integrateBranch: () => Promise.resolve({ status: "integrated", mode: "merge", head: "headafter" }),
    integrationTouchedSrc: () => Promise.resolve(false),
    rebuildDist: () => Promise.resolve({ ok: true, detail: "" }),
    pushPrimaryBranch: () => Promise.resolve({ ok: true, branch: "main" }),
    relocateTask: () => Promise.resolve("moved"),
    restoreDoneCopy: () => Promise.resolve({ ok: true, source: "already:x" }),
    collectWorktreeTelemetry: () => Promise.resolve({ appended: 0, detail: "" }),
    cleanupWorktree: () => Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" }),
    releaseLease: () => Promise.resolve("released"),
  };
  return {
    ...base,
    integrationTouchedUiSrc: () => Promise.resolve(options.touchedUiSrc ?? true),
    rebuildUiBundle: () => {
      calls.rebuildUiBundle += 1;
      return Promise.resolve(
        options.rebuildUiBundleOk === false ? { ok: false, detail: "vite krito" } : { ok: true, detail: "" },
      );
    },
  } satisfies WaveIntegrationPorts;
}

test("`ui-app/src` paliestas — rebuildUiBundle kviečiamas ir sėkmė loguojama", async () => {
  const logs: string[] = [];
  const calls = { rebuildUiBundle: 0 };
  const ports = basePorts({ touchedUiSrc: true }, calls, logs, []);
  await createIntegrationStepRunner(ports, new Set()).run(STEP);

  assert.equal(calls.rebuildUiBundle, 1);
  assert.ok(logs.some((line) => line === "INTEGRATION UI BUNDLE REBUILT: task=0161 head=headafter"));
});

test("`ui-app/src` NEpaliestas — rebuildUiBundle nekviečiamas", async () => {
  const logs: string[] = [];
  const calls = { rebuildUiBundle: 0 };
  const ports = basePorts({ touchedUiSrc: false }, calls, logs, []);
  await createIntegrationStepRunner(ports, new Set()).run(STEP);

  assert.equal(calls.rebuildUiBundle, 0);
  assert.ok(!logs.some((line) => line.includes("UI BUNDLE")));
});

test("rebuildUiBundle nesėkmė NEparkuoja ir NEstabdo integracijos", async () => {
  const logs: string[] = [];
  const events: string[] = [];
  const calls = { rebuildUiBundle: 0 };
  const ports = basePorts({ touchedUiSrc: true, rebuildUiBundleOk: false }, calls, logs, events);
  await createIntegrationStepRunner(ports, new Set()).run(STEP);

  assert.equal(calls.rebuildUiBundle, 1);
  assert.ok(logs.some((line) => line.startsWith("INTEGRATION UI BUNDLE REBUILD FAILED: task=0161")));
  assert.ok(!events.includes("worker_integration_parked"));
  assert.ok(logs.some((line) => line.startsWith("WORKER INTEGRATION COMPLETED:")));
});

test("neprivalomi portai nepaduoti — žingsnis praleidžiamas tyliai, integracija baigiasi normaliai", async () => {
  const logs: string[] = [];
  const base: WaveIntegrationPorts = {
    runId: "r1",
    waveContext: () => ({ waveId: "w1", graphHash: "h" }),
    safeLog: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    safeEvent: () => Promise.resolve(),
    resolveWorktreeLayout: (identity) => ({ relativePath: `.worktrees/${identity.worker_id}`, branch: `ag/${identity.task_id}` }),
    locateTask: () => Promise.resolve("terminal-bucket"),
    resolvePrimaryHead: () => Promise.resolve("headbefore"),
    integrateBranch: () => Promise.resolve({ status: "integrated", mode: "merge", head: "headafter" }),
    integrationTouchedSrc: () => Promise.resolve(false),
    rebuildDist: () => Promise.resolve({ ok: true, detail: "" }),
    pushPrimaryBranch: () => Promise.resolve({ ok: true, branch: "main" }),
    relocateTask: () => Promise.resolve("moved"),
    restoreDoneCopy: () => Promise.resolve({ ok: true, source: "already:x" }),
    collectWorktreeTelemetry: () => Promise.resolve({ appended: 0, detail: "" }),
    cleanupWorktree: () => Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" }),
    releaseLease: () => Promise.resolve("released"),
  };
  await createIntegrationStepRunner(base, new Set()).run(STEP);

  assert.ok(!logs.some((line) => line.includes("UI BUNDLE")));
  assert.ok(logs.some((line) => line.startsWith("WORKER INTEGRATION COMPLETED:")));
});
