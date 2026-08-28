// Task 063-b-03: verify-task šaka, kviečianti preserved-work review use-case (063-a) ant
// `ROLLBACK PRESERVED: … ref=<ref>` eilutės. Portas paduodamas per verifyTask options —
// jo nebuvimas (esamas task-execution-run.test.ts scenarijus) elgesio nekeičia.
import assert from "node:assert/strict";
import test from "node:test";
import { verifyTask, PRESERVED_WORK_RECOVERED_TAG } from "../application/task-execution/verify-task.js";
import { createTaskRunState } from "../application/task-execution/task-run-state.js";
import { createFakeTaskRunEnv, fakeBucketPath } from "./helpers/fake-task-run-ports.js";
import type { MaterializePreservedWorkOutcome, PreservedWorkReviewPorts } from "../application/task-execution/preserved-work-review-model.js";

const TASK = "0042";
const TASK_MD_NAME = `${TASK}.md`;
const REF = "refs/verqestra/preserved/deadbeef";
const ROLLBACK_OUTPUT =
  `ROLLBACK PRESERVED: task=${TASK} ref=${REF} commit=deadbeef paths=1 record=/vq/state/rollback-preserved/${TASK}.json`;

const TASK_BODY = `# Task

## Failai
Leidžiama:
- \`src/x.ts\`

## Patikra
- \`pnpm typecheck\`
`;

function fakeReviewPorts(options: {
  changedPaths: string[];
  exitCodes: Record<string, number>;
  materializeOutcome?: MaterializePreservedWorkOutcome;
}): PreservedWorkReviewPorts {
  return {
    materialize: async () =>
      options.materializeOutcome ?? {
        ok: true,
        work: {
          worktreePath: "/worktrees/preserved/deadbeef",
          changedPaths: options.changedPaths,
          dispose: async () => {},
        },
      },
    runCheck: async (_worktreePath, command) => {
      const exitCode = options.exitCodes[command] ?? 0;
      return { exitCode, output: exitCode === 0 ? "ok" : `FAIL: ${command}` };
    },
  };
}

/** `verifyEnv`-lygio setup (task-execution-run.test.ts): purvinas medis, be commit'o, rollback preserved'ina darbą. */
async function preservedRunEnv() {
  const env = createFakeTaskRunEnv();
  const file = fakeBucketPath("active", TASK_MD_NAME);
  env.files.set(file, TASK_BODY);
  const state = await createTaskRunState(file, env.ports, { interrupted: true });
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.productDirtyCount = 1;
  env.behavior.git.committedProductWorkSha = undefined;
  env.behavior.cli = (args) =>
    args[0] === "rollback-stable" ? { code: 0, output: ROLLBACK_OUTPUT } : 0;
  return { env, state };
}

test("verifyTask: žalias preserved-work review verdiktas -> done su PRESERVED-WORK-RECOVERED žyma", async () => {
  const { env, state } = await preservedRunEnv();
  const preservedWorkReview = fakeReviewPorts({
    changedPaths: ["src/x.ts"],
    exitCodes: { "pnpm typecheck": 0 },
  });

  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d", preservedWorkReview });

  assert.deepEqual(result, {
    kind: "done",
    preservedWorkRecovered: { ref: REF, tag: PRESERVED_WORK_RECOVERED_TAG },
  });
});

test("verifyTask: raudonas preserved-work review verdiktas -> human-review su patikrų uodega ir ref", async () => {
  const { env, state } = await preservedRunEnv();
  const preservedWorkReview = fakeReviewPorts({
    changedPaths: ["src/x.ts"],
    exitCodes: { "pnpm typecheck": 1 },
  });

  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d", preservedWorkReview });

  assert.equal(result.kind, "human-review");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, new RegExp(`preserved_work_review ref=${REF.replace(/\//g, "\\/")}`));
  assert.match(reason, /checks_failed=1/);
  assert.match(reason, /\[pnpm typecheck] exit=1 FAIL: pnpm typecheck/);
});

test("verifyTask: preserved ref be turinio (materializavimas nepavyko) -> human-review kaip dabar", async () => {
  const { env, state } = await preservedRunEnv();
  const preservedWorkReview = fakeReviewPorts({
    changedPaths: [],
    exitCodes: {},
    materializeOutcome: { ok: false, reason: "worktree_create_failed" },
  });

  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d", preservedWorkReview });

  assert.equal(result.kind, "human-review");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, new RegExp(`^TASK NOT DONE: ${TASK} Claude did not create a new commit preserved_work=${REF.replace(/\//g, "\\/")}$`));
  assert.doesNotMatch(reason, /preserved_work_review/);
  assert.doesNotMatch(reason, /preserved_work_materialize_failed/);
});

test("verifyTask: be preservedWorkReview porto -> elgesys nepakitęs (backward compat)", async () => {
  const { env, state } = await preservedRunEnv();

  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d" });

  assert.equal(result.kind, "human-review");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, new RegExp(`^TASK NOT DONE: ${TASK} Claude did not create a new commit preserved_work=${REF.replace(/\//g, "\\/")}$`));
});
