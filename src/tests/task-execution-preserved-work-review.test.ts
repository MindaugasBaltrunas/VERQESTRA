// Task 063-a: preserved-work review use-case — verdiktas ("recovered" | "needs-human") iš
// fake portų, jokios realios FS/git/child_process.
import assert from "node:assert/strict";
import test from "node:test";
import { reviewPreservedWork } from "../application/task-execution/preserved-work-review.js";
import type {
  MaterializePreservedWorkOutcome,
  PreservedWorkReviewPorts,
} from "../application/task-execution/preserved-work-review-model.js";

const REF = "refs/verqestra/preserved/abc123";

const TASK_MD = `# Task

## Failai
Leidžiama:
- \`src/application/task-execution/preserved-work-review.ts\`
- \`src/tests/task-execution-preserved-work-review.test.ts\`

## Patikra
- \`pnpm typecheck\`
- \`pnpm test:only\`
`;

function fakePorts(options: {
  changedPaths: string[];
  exitCodes: Record<string, number>;
  materializeOutcome?: MaterializePreservedWorkOutcome;
}): { ports: PreservedWorkReviewPorts; disposed: boolean[] } {
  const disposed: boolean[] = [];
  const ports: PreservedWorkReviewPorts = {
    materialize: async () =>
      options.materializeOutcome ?? {
        ok: true,
        work: {
          worktreePath: "/worktrees/preserved/abc123",
          changedPaths: options.changedPaths,
          dispose: async () => {
            disposed.push(true);
          },
        },
      },
    runCheck: async (_worktreePath: string, command: string) => {
      const exitCode = options.exitCodes[command] ?? 0;
      return { exitCode, output: exitCode === 0 ? "ok" : `FAIL: ${command}` };
    },
  };
  return { ports, disposed };
}

test("reviewPreservedWork: žalios patikros + allowlist OK -> recovered", async () => {
  const { ports, disposed } = fakePorts({
    changedPaths: ["src/application/task-execution/preserved-work-review.ts"],
    exitCodes: { "pnpm typecheck": 0, "pnpm test:only": 0 },
  });

  const verdict = await reviewPreservedWork({ ref: REF, taskMarkdown: TASK_MD }, ports);

  assert.equal(verdict.verdict, "recovered");
  assert.equal(verdict.ref, REF);
  assert.deepEqual(verdict.changedPaths, ["src/application/task-execution/preserved-work-review.ts"]);
  assert.equal(verdict.checks.length, 2);
  assert.deepEqual(disposed, [true], "worktree pašalinamas po peržiūros");
});

test("reviewPreservedWork: raudona patikra -> needs-human su uodega", async () => {
  const { ports } = fakePorts({
    changedPaths: ["src/application/task-execution/preserved-work-review.ts"],
    exitCodes: { "pnpm typecheck": 1, "pnpm test:only": 0 },
  });

  const verdict = await reviewPreservedWork({ ref: REF, taskMarkdown: TASK_MD }, ports);

  assert.equal(verdict.verdict, "needs-human");
  if (verdict.verdict !== "needs-human") throw new Error("unreachable");
  assert.match(verdict.reason, /ref=refs\/verqestra\/preserved\/abc123/);
  assert.match(verdict.reason, /checks_failed=1/);
  assert.match(verdict.reason, /pnpm typecheck/);
  assert.match(verdict.reason, /FAIL: pnpm typecheck/);
});

test("reviewPreservedWork: failas už allowlist ribų -> needs-human net esant žalioms patikroms", async () => {
  const { ports } = fakePorts({
    changedPaths: ["src/application/task-execution/preserved-work-review.ts", "src/infrastructure/git/rollback-scope.ts"],
    exitCodes: { "pnpm typecheck": 0, "pnpm test:only": 0 },
  });

  const verdict = await reviewPreservedWork({ ref: REF, taskMarkdown: TASK_MD }, ports);

  assert.equal(verdict.verdict, "needs-human");
  if (verdict.verdict !== "needs-human") throw new Error("unreachable");
  assert.match(verdict.reason, /paths_outside_allowlist=src\/infrastructure\/git\/rollback-scope\.ts/);
  assert.equal(verdict.checks.every((check) => check.exitCode === 0), true, "patikros liko žalios");
});

test("reviewPreservedWork: materializavimo nesėkmė -> needs-human be jokios patikros", async () => {
  const { ports } = fakePorts({
    changedPaths: [],
    exitCodes: {},
    materializeOutcome: { ok: false, reason: "ref-not-found" },
  });

  const verdict = await reviewPreservedWork({ ref: REF, taskMarkdown: TASK_MD }, ports);

  assert.equal(verdict.verdict, "needs-human");
  if (verdict.verdict !== "needs-human") throw new Error("unreachable");
  assert.match(verdict.reason, /preserved_work_materialize_failed=ref-not-found/);
  assert.match(verdict.reason, new RegExp(`ref=${REF}`));
  assert.deepEqual(verdict.checks, []);
});
