// Task 063-c: composition surišimo testas — REALUS preserved ref (git laikinoje repozitorijoje,
// ta pati schema kaip infrastructure-git-preserved-work.test.ts), REALUS
// `composition/loop/preserved-work-adapters.ts` adapteris (jokio fake materialize/runCheck) ir
// REALUS `createRunCoordinator` kelias per naujai pridėtą `RunCoordinatorOptions.preservedWorkReview`
// (run-coordinator.ts) — parodo, kad adapteris paduotas iš composition realiai pasiekia
// `verify-task` sprendimo šaką gyvame `.start()` bėgime, ne tik izoliuotame vienetų teste.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { gitHead } from "../infrastructure/git/git-client.js";
import { restoreTaskScope } from "../infrastructure/git/rollback-scope.js";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import { createTaskRunState } from "../application/task-execution/task-run-state.js";
import { verifyTask, PRESERVED_WORK_RECOVERED_TAG } from "../application/task-execution/verify-task.js";
import { preservedWorkReviewPorts } from "../composition/loop/preserved-work-adapters.js";
import { createFakeTaskRunEnv, fakeBucketPath, type FakeTaskRunEnv } from "./helpers/fake-task-run-ports.js";

const TASK = "0099";
const TASK_MD_NAME = `${TASK}.md`;

const root = await mkdtemp(path.join(tmpdir(), "vq-preserved-wiring-"));
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
// `worktreeRootIsIgnored` blokuoja `git worktree add`, kai `.ag/` negitignore'inta.
await nodeFsAdapter.writeTextFile(path.join(root, ".gitignore"), ".ag/\n");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "x.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");
const stable = await gitHead(root);
assert.ok(stable);

// Necommit'intas darbas, kurį testas išsaugo per `restoreTaskScope` — tiksliai tas pats
// mechanizmas, kurį naudoja `rollback-stable`.
await nodeFsAdapter.writeTextFile(path.join(root, "src", "x.ts"), "atlikta darbas\n");
const restored = await restoreTaskScope(root, stable, ["src/x.ts"]);
assert.equal(restored.ok, true, JSON.stringify(restored));
if (!restored.ok) throw new Error("unreachable");
assert.ok(restored.preserved, "preserve turėjo sukurti refs/verqestra/preserved/<sha>");
const PRESERVED = restored.preserved;

const ROLLBACK_OUTPUT =
  `ROLLBACK PRESERVED: task=${TASK} ref=${PRESERVED.ref} commit=${PRESERVED.commit} paths=1 ` +
  `record=/vq/state/rollback-preserved/${TASK}.json`;

function taskBody(check: string): string {
  return `# Task

## Failai
Leidžiama:
- \`src/x.ts\`

## Patikra
- \`${check}\`
`;
}

// Be kabučių: `runShell` perduoda komandą per platformos shell'ą (`cmd.exe /c` Windows'e), o
// Node argv->command-line konvertavimas + cmd.exe parseris viduje esančias `"` perkoduoja
// dukart — `exit <kodas>` yra deterministinis exit be jokio citavimo abiejose platformose.
const GREEN_CHECK = "exit 0";
const RED_CHECK = "exit 1";

/** `preservedRunEnv`: purvinas medis, be commit'o, rollback-stable jau preserve'ino darbą. */
async function preservedRunEnv(check: string): Promise<{ env: FakeTaskRunEnv; state: Awaited<ReturnType<typeof createTaskRunState>> }> {
  const env = createFakeTaskRunEnv();
  const file = fakeBucketPath("active", TASK_MD_NAME);
  env.files.set(file, taskBody(check));
  const state = await createTaskRunState(file, env.ports, { interrupted: true });
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.productDirtyCount = 1;
  env.behavior.git.committedProductWorkSha = undefined;
  env.behavior.cli = (args) => (args[0] === "rollback-stable" ? { code: 0, output: ROLLBACK_OUTPUT } : 0);
  return { env, state };
}

test("composition adapteris: žalias realus preserved darbas -> verifyTask done su PRESERVED-WORK-RECOVERED", async () => {
  const { env, state } = await preservedRunEnv(GREEN_CHECK);
  const preservedWorkReview = preservedWorkReviewPorts({ projectRoot: root });

  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d", preservedWorkReview });

  assert.deepEqual(result, {
    kind: "done",
    preservedWorkRecovered: { ref: PRESERVED.ref, tag: PRESERVED_WORK_RECOVERED_TAG },
  });
});

test("composition adapteris: raudonas realus preserved darbas -> human-review su patikrų uodega ir ref", async () => {
  const { env, state } = await preservedRunEnv(RED_CHECK);
  const preservedWorkReview = preservedWorkReviewPorts({ projectRoot: root });

  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d", preservedWorkReview });

  assert.equal(result.kind, "human-review");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, new RegExp(`preserved_work_review ref=${PRESERVED.ref.replace(/\//g, "\\/")}`));
  assert.match(reason, /checks_failed=1/);
});

function seedQueue(env: FakeTaskRunEnv, body: string): string {
  const queuedFile = fakeBucketPath("queue", TASK_MD_NAME);
  env.files.set(queuedFile, body);
  return queuedFile;
}

/** Pilnas `queue -> ... -> verify -> rollback -> preserved review -> done` kelias per REALŲ `.start()`. */
function fullCoordinatorEnv(check: string): { env: FakeTaskRunEnv; queuedFile: string } {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env, taskBody(check));
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.git.productDirtyCount = 1;
  env.behavior.cli = (args) => {
    if (args[0] === "claude-diagnose") {
      env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
      return 0;
    }
    if (args[0] === "rollback-stable") return { code: 0, output: ROLLBACK_OUTPUT };
    return 0;
  };
  return { env, queuedFile };
}

test("surišimas: createRunCoordinator su composition adapteriu praveda žalią preserved darbą iki done gyvame .start() kelyje", async () => {
  const { env, queuedFile } = fullCoordinatorEnv(GREEN_CHECK);
  const preservedWorkReview = preservedWorkReviewPorts({ projectRoot: root });

  const coordinator = createRunCoordinator(env.ports, { preservedWorkReview });
  const result = await coordinator.start(queuedFile);

  assert.equal(result, true, "žalias preserved review turi baigtis done=true");
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD_NAME)), "failas terminaliniame done bucket'e");
  assert.ok(env.logs.some((line) => line === `TASK DONE: ${TASK}`));
});

test("surišimas: be adapterio (options be preservedWorkReview) elgesys nekinta — parkuojama human-review", async () => {
  const { env, queuedFile } = fullCoordinatorEnv(GREEN_CHECK);

  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);

  assert.equal(result, false, "be adapterio nėra kaip patvirtinti preserved darbo — turi likti human-review");
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD_NAME)));
  const reason = env.journalEvents.at(-1)?.reason ?? "";
  assert.match(reason, new RegExp(`preserved_work=${PRESERVED.ref.replace(/\//g, "\\/")}`));
});
