// VQ-305 (1 dalis): kontraktų diff ir bangos plano unit testai — ekstrakcija (TS/route/
// config/SQL/prisma/migracija), rizikos taisyklės (removed/member/signature/added),
// unverified keliai ir generated drift, diff atspaudo determinizmas, ref segmentai ir
// branch vardai, plano vartų tvarka ir scope patikra per kanoninį domain matcher'į.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/index.js";
import {
  assessIntegrationRisk,
  changedContractIds,
  createIntegrationPlan,
  diffContracts,
  extractContracts,
  integrationBranchName,
  isIntegrationBranchName,
  isPathInScope,
  sanitizeRefSegment,
  unverifiedContractPaths,
  type ContractSourceFile,
} from "../application/integration/index.js";

function tsFile(path: string, text: string): ContractSourceFile {
  return { path, text };
}

// ---------------------------------------------------------------------------
// Ekstrakcija
// ---------------------------------------------------------------------------

test("extractContracts: TS eksportai su nariais, re-eksportai ir overload dedupe", () => {
  const text = [
    "export function run(alpha: string, beta?: number): void {}",
    "export function run(alpha: string): void {}",
    "export interface Shape { width: number; height: number }",
    "export type Mode = { fast: boolean; safe: boolean };",
    "export const schema = z.object({ id: z.string(), name: z.string() });",
    'export { helper as publicHelper } from "./helper.js";',
    'export * as util from "./util.js";',
  ].join("\n");

  const contracts = extractContracts(tsFile("src/api.ts", text));
  const ids = contracts.map((entry) => entry.id);
  assert.ok(ids.includes("ts-export:src/api.ts#run"));
  assert.ok(ids.includes("ts-export:src/api.ts#run#2"), "overload gets a #2 suffix instead of collapsing");
  const fn = contracts.find((entry) => entry.id === "ts-export:src/api.ts#run");
  assert.deepEqual(fn?.members, ["alpha", "beta"], "function members are its parameter names");
  const shape = contracts.find((entry) => entry.id === "ts-export:src/api.ts#Shape");
  assert.deepEqual(shape?.members, ["height", "width"]);
  const schema = contracts.find((entry) => entry.id === "ts-export:src/api.ts#schema");
  assert.deepEqual(schema?.members, ["id", "name"], "const initializer object keys are members");
  assert.ok(ids.includes("ts-export:src/api.ts#publicHelper"));
  assert.ok(ids.includes("ts-export:src/api.ts#util"));
});

test("extractContracts: API maršrutai, JSON config raktai, SQL/prisma/migracija", () => {
  const routes = extractContracts(
    tsFile("src/server.ts", 'app.get("/health", handler);\nconst r = { method: "post", path: "/items" };'),
  );
  const routeIds = routes.map((entry) => entry.id);
  assert.ok(routeIds.includes("api-route:GET /health"));
  assert.ok(routeIds.includes("api-route:POST /items"));

  const config = extractContracts({ path: "vq/config/limits.json", text: '{"budget":{"max":5},"paths":["a","b"]}' });
  const budget = config.find((entry) => entry.id === "config-key:vq/config/limits.json#budget");
  assert.equal(budget?.signature, "object");
  assert.deepEqual(budget?.members, ["max"]);
  const paths = config.find((entry) => entry.id === "config-key:vq/config/limits.json#paths");
  assert.deepEqual(paths?.members, ["a", "b"], "config array is a SET — its values are members");

  const sql = extractContracts({
    path: "db/migrations/0001_init.sql",
    text: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, PRIMARY KEY (id));\nDROP TABLE legacy;",
  });
  const table = sql.find((entry) => entry.id === "db-entity:users");
  assert.deepEqual(table?.members, ["email", "id"], "constraints are not columns");
  const migration = sql.find((entry) => entry.kind === "db-migration");
  assert.ok(migration, "migration path also yields a db-migration descriptor");

  const prisma = extractContracts({ path: "prisma/schema.prisma", text: "model User {\n  id Int @id\n  email String\n  @@index([email])\n}" });
  assert.deepEqual(prisma[0]?.members, ["email", "id"]);
});

// ---------------------------------------------------------------------------
// Diff taisyklės
// ---------------------------------------------------------------------------

test("diffContracts: removed/member/signature → breaking; added member → potential; added config key → potential", () => {
  const before = [tsFile("src/api.ts", "export function run(alpha: string, beta: string): void {}\nexport const GONE = 1;")];
  const after = [tsFile("src/api.ts", "export function run(alpha: string): void {}")];
  const report = diffContracts({ before, after });

  const removed = report.entries.find((entry) => entry.id === "ts-export:src/api.ts#GONE");
  assert.equal(removed?.change, "removed");
  assert.equal(removed?.breaking_risk, "breaking");
  const changed = report.entries.find((entry) => entry.id === "ts-export:src/api.ts#run");
  assert.equal(changed?.breaking_risk, "breaking", "removed parameter is a member subtraction");
  assert.equal(report.compatible, false);
  assert.ok(report.blocking.length >= 2);
  assert.match(report.diff_hash, /^cd1:[0-9a-f]{16}$/);

  const widened = diffContracts({
    before: [tsFile("src/t.ts", "export interface Opts { a: string }")],
    after: [tsFile("src/t.ts", "export interface Opts { a: string; b?: string }")],
  });
  assert.equal(widened.entries[0]?.breaking_risk, "potential", "only-added members are review-level, not blocking");
  assert.equal(widened.compatible, true);

  const configAdd = diffContracts({
    before: [{ path: "vq/config/x.json", text: "{}" }],
    after: [{ path: "vq/config/x.json", text: '{"newKey":1}' }],
  });
  const added = configAdd.entries.find((entry) => entry.change === "added");
  assert.equal(added?.breaking_risk, "potential", "new config key is absent from existing config files");

  const destructive = diffContracts({
    before: [],
    after: [{ path: "db/migrations/0002_drop.sql", text: "DROP TABLE users;" }],
  });
  const migrationEntry = destructive.entries.find((entry) => entry.kind === "db-migration");
  assert.equal(migrationEntry?.breaking_risk, "breaking", "new destructive migration blocks");
});

test("diffContracts: unverified keliai, generated drift ir atspaudo determinizmas", () => {
  const unsupplied = diffContracts({ before: [], after: [], changedPaths: ["src/mystery.ts", "docs/readme.md"] });
  assert.deepEqual(unsupplied.unverified_paths, ["src/mystery.ts"], "only contract-bearing changed paths become unverified");
  assert.equal(unsupplied.compatible, false, "unverified blocks exactly like breaking");
  assert.deepEqual(unverifiedContractPaths(unsupplied), ["src/mystery.ts"]);
  assert.deepEqual(changedContractIds(unsupplied), [], "unverified entries are an evidence gap, not a written contract");

  const noText = diffContracts({ before: [], after: [{ path: "src/present.ts" }] });
  assert.deepEqual(noText.unverified_paths, ["src/present.ts"], "present file without text is unverifiable");

  const drift = diffContracts({
    before: [tsFile("dist/index.js", "export const a = 1;")],
    after: [tsFile("dist/index.js", "export const a = 1;\nexport const b = 2;")],
  });
  assert.equal(drift.entries[0]?.breaking_risk, "unverified", "generated-only change is generated drift");

  const mixedA = diffContracts({
    before: [tsFile("src/a.ts", "export const x = 1;"), tsFile("src/b.ts", "export const y = 1;")],
    after: [tsFile("src/a.ts", "export const x = 1;\nexport const z = 1;"), tsFile("src/b.ts", "export const y = 1;")],
  });
  const mixedB = diffContracts({
    before: [tsFile("src/b.ts", "export const y = 1;"), tsFile("src/a.ts", "export const x = 1;")],
    after: [tsFile("src/b.ts", "export const y = 1;"), tsFile("src/a.ts", "export const x = 1;\nexport const z = 1;")],
  });
  assert.equal(mixedA.diff_hash, mixedB.diff_hash, "diff hash depends on content, never on input order");
});

// ---------------------------------------------------------------------------
// Ref segmentai ir integracijos planas
// ---------------------------------------------------------------------------

test("sanitizeRefSegment ir branch vardai laikosi git ref formato", () => {
  assert.equal(sanitizeRefSegment("run 12//x"), "run-12-x");
  assert.equal(sanitizeRefSegment("..weird..name.lock"), "weird.namelock");
  assert.equal(sanitizeRefSegment("!!!"), "x", "a segment can never become empty");
  assert.equal(integrationBranchName("run 1", "w2-abc"), "ag/integration/run-1/w2-abc");
  assert.equal(isIntegrationBranchName("ag/integration/run-1/w2-abc"), true);
  assert.equal(isIntegrationBranchName("ag/integration/run-1"), false);
  assert.equal(isIntegrationBranchName("feature/x/y/z"), false);
});

test("isPathInScope naudoja kanoninį domain glob matcher'į", () => {
  assert.equal(isPathInScope("src/a/inner.ts", ["src/a/**"]), true);
  assert.equal(isPathInScope("src/a/inner.ts", ["src/a/*"]), true);
  assert.equal(isPathInScope("src/a/deep/inner.ts", ["src/a/*"]), false, "/* is one level only");
  assert.equal(isPathInScope("src/b/x.ts", ["src/a/**"]), false);
  assert.equal(isPathInScope("src/infrastructure/db.ts", ["src/infrastructure/*.ts"]), true);
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("createIntegrationPlan: laimingas kelias ir vartų tvarka su vardais", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/done/0001-a.md", status: "done", checks: ["x"], scope: ["src/a/**"] },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["x"], scope: ["src/b/**"], depends_on: ["0001"] },
    ],
  });

  const ok = createIntegrationPlan({
    runId: "run-1",
    waveId: "w1-abc",
    graph,
    baseHead: SHA_A,
    results: [{ task_id: "0002", commits: [{ sha: SHA_B, files: ["src/b/mod.ts"], subject: "feat: b" }] }],
  });
  assert.equal(ok.ok, true, ok.violations.map((entry) => entry.code).join(","));
  assert.equal(ok.branch, "ag/integration/run-1/w1-abc");
  assert.deepEqual(ok.commits.map((commit) => [commit.order, commit.sha]), [[1, SHA_B]]);
  assert.equal(ok.risk.verdict, "routine");
  assert.match(ok.plan_hash, /^ip1:[0-9a-f]{16}$/);

  const broken = createIntegrationPlan({
    runId: "run-1",
    waveId: "w1-abc",
    graph,
    baseHead: "not-a-sha",
    dirtyPaths: ["src/dirty.ts"],
    results: [
      { task_id: "0999", commits: [{ sha: SHA_A, files: [] }] },
      { task_id: "0002", commits: [] },
    ],
  });
  const codes = broken.violations.map((entry) => entry.code);
  assert.ok(codes.includes("invalid-base-head"));
  assert.ok(codes.includes("dirty-worktree"));
  assert.ok(codes.includes("unknown-task"));
  assert.ok(codes.includes("missing-commit"));
  assert.ok(codes.includes("empty-wave"));
  assert.equal(broken.ok, false);
});

test("createIntegrationPlan: scope, dublikatai, nežinomi failai ir priklausomybės bangos ribose", () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "0001", file: "AG/tasks/queue/0001-a.md", checks: ["x"], scope: ["src/a/**"] },
      { task_id: "0002", file: "AG/tasks/queue/0002-b.md", checks: ["x"], scope: ["src/b/**"], depends_on: ["0001"] },
    ],
  });

  const plan = createIntegrationPlan({
    runId: "r",
    waveId: "w",
    graph,
    baseHead: SHA_A,
    results: [
      {
        task_id: "0002",
        commits: [
          { sha: SHA_B, files: ["src/b/ok.ts", "src/a/violation.ts"] },
          { sha: SHA_B, files: ["src/b/dup.ts"] },
          { sha: "c".repeat(40) },
        ],
      },
    ],
  });
  const codes = plan.violations.map((entry) => entry.code);
  assert.ok(codes.includes("out-of-scope-path"));
  assert.ok(codes.includes("duplicate-commit"));
  assert.ok(codes.includes("unknown-commit-files"));
  assert.ok(codes.includes("unsatisfied-dependency"), "blocker 0001 is neither in this wave nor done");
  assert.equal(plan.ok, false);
});

test("assessIntegrationRisk: požymiai iš kelių formos, rutina be jų", () => {
  const risky = assessIntegrationRisk([
    "db/migrations/0001.sql",
    "src/auth/session.ts",
    "pnpm-lock.yaml",
    "src/sdk/index.ts",
  ]);
  assert.equal(risky.verdict, "review-required");
  const signals = risky.signals.map((entry) => entry.signal);
  assert.ok(signals.includes("database-migration"));
  assert.ok(signals.includes("auth-security"));
  assert.ok(signals.includes("dependency-manifest"));
  assert.ok(signals.includes("public-contract"));

  assert.equal(assessIntegrationRisk(["src/feature/logic.ts"]).verdict, "routine");
});
