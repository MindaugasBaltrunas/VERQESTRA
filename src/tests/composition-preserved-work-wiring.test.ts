// 063-ca-02: preserved-work review portas surištas su REALIAIS composition adapteriais
// (preserved-work-adapters.ts) — `createRunCoordinator` čia gauna tikrą `git worktree`
// materializavimą ir realų shell `runCheck`, o ne application-lygio fake'us (žr.
// task-execution-coordinator.test.ts, kuris tą patį verify kelią tikrina su fake portais).
//
// REALUS git laikinoje repozitorijoje — ta pati schema kaip infrastructure-git-preserved-
// work.test.ts: preserved ref'as gaunamas iš tikro `restoreTaskScope` (rollback-scope.ts), o
// patikros komanda paleidžiama realiu `runShell` ant materializuoto worktree.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import { buildLoopCyclePorts, type LoopCommandDeps } from "../composition/loop/command.js";
import { preservedWorkReviewPort } from "../composition/loop/preserved-work-adapters.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { gitHead, gitRefExists } from "../infrastructure/git/git-client.js";
import { PRESERVED_REF_PREFIX, restoreTaskScope } from "../infrastructure/git/rollback-scope.js";
import { createFakeTaskRunEnv, fakeBucketPath, type FakeTaskRunEnv } from "./helpers/fake-task-run-ports.js";

const TASK = "0042";
const TASK_MD = `${TASK}.md`;

const root = await mkdtemp(path.join(tmpdir(), "vq-preserved-work-wiring-"));
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function git(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await run("git", ["-C", root, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
// Task-scoped worktree'ai gyvena `.ag/worktrees/...` — be gitignore `worktreeRootIsIgnored`
// blokuoja `git worktree add`.
await nodeFsAdapter.writeTextFile(path.join(root, ".gitignore"), ".ag/\n");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "x.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");

const stable = await gitHead(root);
assert.ok(stable);

// Necommit'intas edit — tiksliai tai, ką rollback'as užfiksuoja preserved ref'e prieš atstatymą.
await nodeFsAdapter.writeTextFile(path.join(root, "src", "x.ts"), "necommitintas edit\n");
const restored = await restoreTaskScope(root, stable, ["src/x.ts"]);
assert.equal(restored.ok, true, JSON.stringify(restored));
if (!restored.ok) throw new Error("unreachable");
assert.ok(restored.preserved, "preserve turėjo sukurti refs/verqestra/preserved/<sha>");
const PRESERVED_REF = restored.preserved.ref;

const TASK_BODY = `# Task

## Failai
Leidžiama:
- \`src/x.ts\`

## Patikra
- \`node -e "process.exit(0)"\`
`;

/**
 * `done` verdiktas be naujo commit'o + purvinas medis → rollback preserved'ina darbą (etaloną
 * žr. task-execution-coordinator.test.ts `preservedRollbackEnv`). Skirtumas čia — `PRESERVED_REF`
 * yra TIKRAS ref, egzistuojantis realiame temp repo, tad `preservedWorkReviewPort` gali jį
 * materializuoti per tikrą `git worktree add`.
 */
function preservedRollbackEnv(): { env: FakeTaskRunEnv; activeFile: string } {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, TASK_BODY);
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.productDirtyCount = 1;
  env.behavior.git.committedProductWorkSha = undefined;
  env.behavior.cli = (args) =>
    args[0] === "rollback-stable"
      ? {
          code: 0,
          output: `ROLLBACK PRESERVED: task=${TASK} ref=${PRESERVED_REF} commit=deadbeef paths=1 record=/vq/state/rollback-preserved/${TASK}.json`,
        }
      : 0;
  return { env, activeFile };
}

test("preservedWorkReviewPort: realus git+shell adapteris uždaro atkurtą preserved darbą iki done", async () => {
  const { env, activeFile } = preservedRollbackEnv();
  const coordinator = createRunCoordinator(env.ports, {
    preservedWorkReview: preservedWorkReviewPort({ projectRoot: root }),
  });

  const result = await coordinator.resume("active", activeFile);

  assert.equal(result, true, "atkurtas preserved darbas uždaro task'ą, o ne parkuoja");
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)), "failas terminaliniame done bucket'e");
  assert.ok(!env.files.has(fakeBucketPath("human-review", TASK_MD)));
});

test("be preservedWorkReview opcijos — elgesys nekinta (backward compat)", async () => {
  const { env, activeFile } = preservedRollbackEnv();
  const coordinator = createRunCoordinator(env.ports);

  const result = await coordinator.resume("active", activeFile);

  assert.equal(result, false);
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD)));
  assert.ok(env.logs.some((line) => line.includes(`preserved_work=${PRESERVED_REF}`)));
});

// ---------------------------------------------------------------------------
// 075-b-03: preserved-ref retencija prijungta prie priežiūros ciklo `reclaimQueue`
// ---------------------------------------------------------------------------
//
// Tas pats REALUS git+failų fixture'as kaip aukščiau: `root` jau turi bazinį commit'ą
// (`stable`), tad naujiems preserved ref'ams tereikia `update-ref`.
const runtimeRoot = path.join(root, "vq");
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeRetentionRef(taskId: string): Promise<string> {
  const ref = `${PRESERVED_REF_PREFIX}${stable}-${taskId}`;
  await git("update-ref", ref, stable as string);
  return ref;
}

async function writeTaskInDoneBucket(taskId: string): Promise<void> {
  await nodeFsAdapter.writeTextFile(path.join(root, "AG", "tasks", "done", `${taskId}.md`), `# ${taskId}\n`);
}

async function writeRetentionRecord(taskId: string, ref: string, ageDays: number): Promise<string> {
  const recordPath = path.join(runtimeRoot, "state", "rollback-preserved", `${taskId}.json`);
  await nodeFsAdapter.writeTextFile(
    recordPath,
    JSON.stringify({
      task_id: taskId,
      ref,
      commit: stable,
      base_ref: stable,
      paths: ["src/x.ts"],
      recorded_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    }),
  );
  return recordPath;
}

function loopDeps(overrides: Partial<LoopCommandDeps> = {}): { deps: LoopCommandDeps; logs: string[] } {
  const logs: string[] = [];
  const emptyQueue = {
    detectBootstrapEligibility: () => Promise.resolve({ bootstrapEligible: false }),
    runBootstrap: () => Promise.resolve({ status: "skipped", render: "" }),
    resolveModel: () => Promise.resolve("model"),
    synthesizeWave: () => Promise.resolve({ created: 0, already_implemented: 0, external_satisfied: 0 } as never),
    runQualityGates: () => Promise.resolve(0),
    dispatchAuditRepair: () => Promise.resolve(),
    runConverge: () => Promise.resolve({ issues: [] }),
    log: () => Promise.resolve(),
    out: () => {},
    env: {},
  } as unknown as LoopCommandDeps["emptyQueue"];

  return {
    logs,
    deps: {
      roots: { projectRoot: root, agRoot: path.join(root, "AG"), runtimeRoot },
      log: async (message: string) => void logs.push(message),
      out: () => {},
      emptyQueue,
      preconditions: { gitStatusPorcelain: () => Promise.resolve([]) } as never,
      taskSelection: {
        listMarkdownFilePaths: () => Promise.resolve([]),
        liveLeaseTaskIds: () => Promise.resolve(new Set<string>()),
      },
      consumeStopRequest: () => Promise.resolve(false),
      resumeTask: () => Promise.resolve(true),
      processAuditRepairTask: () => Promise.resolve(),
      env: {},
      ...overrides,
    },
  };
}

test("reclaimQueue: senas done preserved ref'as pašalinamas su numatytąja 14 parų riba", async () => {
  const taskId = "0900-retention-default";
  await writeTaskInDoneBucket(taskId);
  const ref = await makeRetentionRef(taskId);
  await writeRetentionRecord(taskId, ref, 15);

  const { deps, logs } = loopDeps();
  const ports = buildLoopCyclePorts(deps);
  const lines = await ports.reclaimQueue();

  assert.equal(await gitRefExists(ref, root), false, "16 dienų senas ref virš 14 parų ribos privalo būti pašalintas");
  assert.ok(
    logs.some((line) => line.startsWith(`PRESERVED REF EXPIRED: ${ref}`)),
    `tikėtasi PRESERVED REF EXPIRED žurnalo eilutės, gauta: ${JSON.stringify(logs)}`,
  );
  assert.ok(!lines.some((line) => line.startsWith("PRESERVED REF RETENTION FAILED")));
});

test("reclaimQueue: AG_PRESERVED_REF_RETENTION_DAYS konfigūracija, ne hardcode — 5 dienų ref'as išlieka su numatytąja, bet pašalinamas su override", async () => {
  const taskId = "0900-retention-config";
  await writeTaskInDoneBucket(taskId);
  const ref = await makeRetentionRef(taskId);
  await writeRetentionRecord(taskId, ref, 5);

  const withoutOverride = loopDeps();
  await buildLoopCyclePorts(withoutOverride.deps).reclaimQueue();
  assert.equal(await gitRefExists(ref, root), true, "5 dienų ref'as jaunesnis už numatytąją 14 parų ribą — turi likti");

  const withOverride = loopDeps({ env: { AG_PRESERVED_REF_RETENTION_DAYS: "3" } });
  await buildLoopCyclePorts(withOverride.deps).reclaimQueue();
  assert.equal(await gitRefExists(ref, root), false, "riba nuleista iki 3 parų per konfigūraciją — 5 dienų ref'as turi būti pašalintas");
});

test("reclaimQueue: retencijos klaida NENUTRAUKIA likusio priežiūros ciklo", async () => {
  const taskId = "0900-retention-error";
  await writeTaskInDoneBucket(taskId);
  const ref = await makeRetentionRef(taskId);
  await writeRetentionRecord(taskId, ref, 20);

  const { deps } = loopDeps({
    log: () => Promise.reject(new Error("žurnalo rašymas nepavyko")),
  });
  const ports = buildLoopCyclePorts(deps);

  const lines = await ports.reclaimQueue();

  assert.ok(
    lines.some((line) => line.startsWith("PRESERVED REF RETENTION FAILED")),
    `tikėtasi klaidos eilutės grąžintame masyve, gauta: ${JSON.stringify(lines)}`,
  );
});
