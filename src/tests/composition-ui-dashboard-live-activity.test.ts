// Task 139-b-03/139-c-01: dashboard'o snapshot'o veiklos stamp'as (`readClaudeLogStamp`)
// privalo naudoti TĄ PAČIĄ gyvo šaltinio rezoliuciją kaip SSE (`sse-adapters.ts`
// `worktreeLiveSources`), o ne globalų `vq/logs/claude-last.log` veidrodį.
//
// Prieš pataisymą pirmas puslapio užkrovimas worktree dispatch'o metu rodydavo SENĄ komandą
// (globalaus veidrodžio fosiliją), kurią SSE tik VĖLIAU pakeisdavo — dvi skirtingos tiesos tame
// pačiame ekrane. Trys scenarijai čia tiksliai atitinka SSE elgesį: worktree dispatch'as gauna
// gyvą kopijos žurnalą, gyvo šaltinio nesant grąžinama tuščia veikla (fosilija nebeišeina), o
// ne-worktree dispatch'as lieka prie esamo attempt-first kelio.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dashboardViewPorts, type DashboardAdapterInput } from "../composition/ui/dashboard-adapters.js";
import { createAttempt, openAttempt } from "../infrastructure/persistence/runtime-artifact-store.js";
import { createWorkerLease, workerLeaseFile } from "../application/scheduling/worker-lease-store.js";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";

const TASK = "0042";

type Sandbox = { projectRoot: string; runtimeRoot: string; agRoot: string };

async function sandbox(): Promise<Sandbox> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-139-dashboard-activity-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  return { projectRoot, runtimeRoot, agRoot: path.join(projectRoot, "AG") };
}

function ports(world: Sandbox): ReturnType<typeof dashboardViewPorts> {
  const input: DashboardAdapterInput = {
    ...world,
    loadWorkflowBuckets: () => Promise.resolve([]),
    logError: () => {},
  };
  return dashboardViewPorts(input);
}

/** Gyvas `held` lease su worktree keliu — ta pati forma kaip SSE `worktreeLiveSources`. */
async function placeWorktreeLease(world: Sandbox, taskId: string, worktreeRelativePath: string): Promise<void> {
  const lease = createWorkerLease(
    { owner_id: "loop-w2", run_id: "r139", worker_id: "w2", task_id: taskId, attempt: 1 },
    { now: new Date(), fencingToken: 1, worktreePath: worktreeRelativePath },
  );
  const file = workerLeaseFile(world.projectRoot, "w2");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(lease), "utf8");
}

async function writeStaleLegacyMirror(world: Sandbox): Promise<void> {
  await mkdir(path.join(world.runtimeRoot, "logs"), { recursive: true });
  await writeFile(
    path.join(world.runtimeRoot, "logs", "claude-last.log"),
    "sena, nesusijusi sesija — neturi patekti į snapshot'ą\n",
    "utf8",
  );
}

test("worktree dispatch: stamp'as ateina iš kopijos gyvo žurnalo per lease", async () => {
  const world = await sandbox();
  try {
    await writeStaleLegacyMirror(world);

    const worktreeRoot = path.join(world.projectRoot, "worktree1");
    await mkdir(path.join(worktreeRoot, "vq", "logs"), { recursive: true });
    await writeFile(path.join(worktreeRoot, "vq", "logs", "claude-last.log"), "gyvas kopijos srautas", "utf8");
    await placeWorktreeLease(world, TASK, "worktree1");

    const stamp = await ports(world).readClaudeLogStamp(TASK);

    assert.equal(stamp.source, "attempt");
    assert.equal(stamp.bytes, Buffer.byteLength("gyvas kopijos srautas", "utf8"));
    assert.ok(stamp.updatedAt !== undefined);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("gyvo šaltinio nėra, tik senas globalus veidrodis → tuščia veikla", async () => {
  const world = await sandbox();
  try {
    await writeStaleLegacyMirror(world);

    const stamp = await ports(world).readClaudeLogStamp(TASK);

    assert.deepEqual(stamp, { source: "none" });
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("ne-worktree dispatch: attempt kanalas lieka pirmenybėje (esamas elgesys)", async () => {
  const world = await sandbox();
  // `resolution.resolveActiveAttempt` (dashboard-adapters.ts) rezoliuciją skaito iš PROCESO env,
  // o šis testas pats gali suktis worker'io dispatch'e su savo AG_RUN_ID/AG_WORKER_ID/AG_ATTEMPT_ID —
  // fiksuojame juos, kad ref'as sutaptų DETERMINISTIŠKAI, o ne pagal aplinkos atsitiktinumą.
  const ENV_KEYS = ["AG_RUN_ID", "AG_WORKER_ID", "AG_ATTEMPT_ID"] as const;
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env["AG_RUN_ID"] = "r139";
    process.env["AG_WORKER_ID"] = "w1";
    process.env["AG_ATTEMPT_ID"] = "a1";
    await writeStaleLegacyMirror(world);

    const ref: AttemptRef = { runId: "r139", workerId: "w1", taskId: TASK, attemptId: "a1" };
    const created = await createAttempt({
      runtimeRoot: world.runtimeRoot,
      ref,
      graphHash: "none",
      policy: {},
      source: { origin: "queue-task" },
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    assert.ok(created.ok);
    const handle = await openAttempt(world.runtimeRoot, ref);
    assert.ok(handle.ok);
    await handle.data.appendLog("claude-last", "attempt kanalo srautas");

    const stamp = await ports(world).readClaudeLogStamp(TASK);

    assert.equal(stamp.source, "attempt");
    assert.equal(stamp.bytes, Buffer.byteLength("attempt kanalo srautas\n", "utf8"));
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
