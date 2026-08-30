// 075-a-02: preserved-ref retencijos testai. Pirma pusė — grynas sprendimas be jokio IO;
// antra — REALUS git laikinoje repozitorijoje, ta pati schema kaip
// infrastructure-git-preserved-work.test.ts / infrastructure-git.test.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { gitHead, gitRefExists } from "../infrastructure/git/git-client.js";
import { PRESERVED_REF_PREFIX } from "../infrastructure/git/rollback-scope.js";
import {
  evaluatePreservedRefRetention,
  expirePreservedRefs,
  PRESERVED_REF_RETENTION_DEFAULT_DAYS,
} from "../infrastructure/git/preserved-ref-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-30T00:00:00.000Z");
const OLD_RECORDED_AT = new Date(NOW.getTime() - (PRESERVED_REF_RETENTION_DEFAULT_DAYS + 1) * DAY_MS).toISOString();
const YOUNG_RECORDED_AT = new Date(NOW.getTime() - 1 * DAY_MS).toISOString();

test("done + amžius > riba -> expire su tikslia log eilute", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: OLD_RECORDED_AT,
    recovered: undefined,
    taskStatus: "done",
    now: NOW,
  });
  assert.equal(decision.expire, true);
  if (!decision.expire) return;
  assert.equal(decision.ageDays, PRESERVED_REF_RETENTION_DEFAULT_DAYS + 1);
  assert.equal(decision.logLine, `PRESERVED REF EXPIRED: ${PRESERVED_REF_PREFIX}deadbeef task=0075 age=${PRESERVED_REF_RETENTION_DEFAULT_DAYS + 1}`);
});

test("done + jaunas -> too-young, nesitrina", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: YOUNG_RECORDED_AT,
    recovered: undefined,
    taskStatus: "done",
    now: NOW,
  });
  assert.deepEqual(decision, { expire: false, reason: "too-young" });
});

test("ne-done (queue/active/...) -> not-done, amžius nesvarbu", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: OLD_RECORDED_AT,
    recovered: undefined,
    taskStatus: "not-done",
    now: NOW,
  });
  assert.deepEqual(decision, { expire: false, reason: "not-done" });
});

test("recovered=false blokuoja trynimą net kai done + senas", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: OLD_RECORDED_AT,
    recovered: false,
    taskStatus: "done",
    now: NOW,
  });
  assert.deepEqual(decision, { expire: false, reason: "recovered-false" });
});

test("nežinoma task būsena -> paliekama", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "9999",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: OLD_RECORDED_AT,
    recovered: undefined,
    taskStatus: "unknown",
    now: NOW,
  });
  assert.deepEqual(decision, { expire: false, reason: "unknown-task-status" });
});

test("recovered=true done+senas vis tiek expire", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: OLD_RECORDED_AT,
    recovered: true,
    taskStatus: "done",
    now: NOW,
  });
  assert.equal(decision.expire, true);
});

test("blogas recorded_at -> invalid-recorded-at, nesitrina", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: `${PRESERVED_REF_PREFIX}deadbeef`,
    recordedAt: "not-a-date",
    recovered: undefined,
    taskStatus: "done",
    now: NOW,
  });
  assert.deepEqual(decision, { expire: false, reason: "invalid-recorded-at" });
});

test("ref be PRESERVED_REF_PREFIX -> invalid-ref-prefix, niekada netrinamas", () => {
  const decision = evaluatePreservedRefRetention({
    taskId: "0075",
    ref: "refs/heads/main",
    recordedAt: OLD_RECORDED_AT,
    recovered: undefined,
    taskStatus: "done",
    now: NOW,
  });
  assert.deepEqual(decision, { expire: false, reason: "invalid-ref-prefix" });
});

// --- Integracija: realus git + failų sistema laikinoje repozitorijoje ---

const root = await mkdtemp(path.join(tmpdir(), "vq-preserved-ref-retention-"));
const runtimeRoot = path.join(root, "vq");
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function git(...args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await run("git", ["-C", root, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");
const commit = await gitHead(root);
assert.ok(commit);

async function makePreservedRef(taskId: string): Promise<string> {
  const ref = `${PRESERVED_REF_PREFIX}${commit}-${taskId}`;
  await git("update-ref", ref, commit as string);
  return ref;
}

async function writeTaskInBucket(bucket: string, taskId: string): Promise<void> {
  await nodeFsAdapter.writeTextFile(path.join(root, "AG", "tasks", bucket, `${taskId}.md`), `# ${taskId}\n`);
}

async function writeRecord(
  taskId: string,
  ref: string,
  recordedAt: string,
  recovered?: boolean,
): Promise<string> {
  const recordPath = path.join(runtimeRoot, "state", "rollback-preserved", `${taskId}.json`);
  await nodeFsAdapter.writeTextFile(
    recordPath,
    JSON.stringify(
      {
        task_id: taskId,
        ref,
        commit,
        base_ref: commit,
        paths: ["src/a.ts"],
        recorded_at: recordedAt,
        ...(recovered === undefined ? {} : { recovered }),
      },
      null,
      2,
    ),
  );
  return recordPath;
}

test("done + senas: ref trinamas, .json pašalinamas, log eilutė paskelbta", async () => {
  const taskId = "done-old";
  await writeTaskInBucket("done", taskId);
  const ref = await makePreservedRef(taskId);
  const recordPath = await writeRecord(taskId, ref, OLD_RECORDED_AT);

  const logs: string[] = [];
  const result = await expirePreservedRefs(root, { agLog: async (line) => void logs.push(line), now: () => NOW }, { runtimeRoot });

  assert.deepEqual(result.expired, [{ taskId, ref, ageDays: PRESERVED_REF_RETENTION_DEFAULT_DAYS + 1 }]);
  assert.equal(await gitRefExists(ref, root), false);
  assert.equal(await nodeFsAdapter.exists(recordPath), false);
  assert.deepEqual(logs, [`PRESERVED REF EXPIRED: ${ref} task=${taskId} age=${PRESERVED_REF_RETENTION_DEFAULT_DAYS + 1}`]);
});

test("jaunas: ref ir .json paliekami, jokio log'o", async () => {
  const taskId = "done-young";
  await writeTaskInBucket("done", taskId);
  const ref = await makePreservedRef(taskId);
  const recordPath = await writeRecord(taskId, ref, YOUNG_RECORDED_AT);

  const logs: string[] = [];
  const result = await expirePreservedRefs(root, { agLog: async (line) => void logs.push(line), now: () => NOW }, { runtimeRoot });

  assert.deepEqual(result.expired, []);
  assert.ok(result.kept.some((entry) => entry.taskId === taskId && entry.reason === "too-young"));
  assert.equal(await gitRefExists(ref, root), true);
  assert.equal(await nodeFsAdapter.exists(recordPath), true);
  assert.deepEqual(logs, []);
});

test("ne-done (queue) + senas: paliekama", async () => {
  const taskId = "queue-old";
  await writeTaskInBucket("queue", taskId);
  const ref = await makePreservedRef(taskId);
  const recordPath = await writeRecord(taskId, ref, OLD_RECORDED_AT);

  const result = await expirePreservedRefs(root, { agLog: async () => undefined, now: () => NOW }, { runtimeRoot });

  assert.deepEqual(result.expired, []);
  assert.ok(result.kept.some((entry) => entry.taskId === taskId && entry.reason === "not-done"));
  assert.equal(await gitRefExists(ref, root), true);
  assert.equal(await nodeFsAdapter.exists(recordPath), true);
});

test("recovered=false + done + senas: paliekama", async () => {
  const taskId = "done-not-recovered";
  await writeTaskInBucket("done", taskId);
  const ref = await makePreservedRef(taskId);
  const recordPath = await writeRecord(taskId, ref, OLD_RECORDED_AT, false);

  const result = await expirePreservedRefs(root, { agLog: async () => undefined, now: () => NOW }, { runtimeRoot });

  assert.deepEqual(result.expired, []);
  assert.ok(result.kept.some((entry) => entry.taskId === taskId && entry.reason === "recovered-false"));
  assert.equal(await gitRefExists(ref, root), true);
  assert.equal(await nodeFsAdapter.exists(recordPath), true);
});

test("nežinoma task būsena (jokiame bucket'e nerastas) + senas: paliekama", async () => {
  const taskId = "nowhere-old";
  const ref = await makePreservedRef(taskId);
  const recordPath = await writeRecord(taskId, ref, OLD_RECORDED_AT);

  const result = await expirePreservedRefs(root, { agLog: async () => undefined, now: () => NOW }, { runtimeRoot });

  assert.deepEqual(result.expired, []);
  assert.ok(result.kept.some((entry) => entry.taskId === taskId && entry.reason === "unknown-task-status"));
  assert.equal(await gitRefExists(ref, root), true);
  assert.equal(await nodeFsAdapter.exists(recordPath), true);
});
