// VQ-305 (1 dalis): rizikos verdikto, semantinės peržiūros, siauro repair, task įrodymų
// surinkimo ir bangos vartų unit testai. LLM/spawn/FS — per fake portus; verdiktų
// fail-closed kryptys (unverified → blokas, reviewer nebuvimas → human-review, missing
// gate → ne-praėjimas) yra kontraktas.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIntegrationReviewPrompt,
  collectTaskIntegrationEvidence,
  conflictForIntegrationRepair,
  createIntegrationRepair,
  diffContracts,
  evaluateIntegrationRisk,
  parseIntegrationReviewResponse,
  reviewIntegration,
  runWaveGates,
  selectWaveTests,
  summarizeTaskIntegrationEvidence,
  MAX_PROMPT_CONTRACTS,
  WAVE_TESTS_ENV,
  type ContractDiffReport,
  type ContractRevisionFile,
  type IntegrationReviewerResponse,
  type WaveGatePolicy,
  type WaveGateReport,
  type RunWaveGatesDeps,
} from "../application/integration/index.js";

function breakingDiff(path = "src/api.ts"): ContractDiffReport {
  return diffContracts({
    before: [{ path, text: "export const removedThing = 1;" }],
    after: [{ path, text: "" }],
  });
}

function emptyDiff(): ContractDiffReport {
  return diffContracts({ before: [], after: [] });
}

// ---------------------------------------------------------------------------
// evaluateIntegrationRisk
// ---------------------------------------------------------------------------

test("evaluateIntegrationRisk: lygiai kyla tik iš blokuojančių įrodymų", () => {
  const routine = evaluateIntegrationRisk({ contractDiff: emptyDiff() });
  assert.equal(routine.level, "routine");
  assert.equal(routine.semantic_review_allowed, false);
  assert.match(routine.verdict_hash, /^ir1:[0-9a-f]{16}$/);

  const breaking = evaluateIntegrationRisk({ contractDiff: breakingDiff() });
  assert.equal(breaking.level, "review-required");
  assert.equal(breaking.semantic_review_allowed, true);
  assert.equal(breaking.signals[0]?.code, "contract-break");

  const unverified = evaluateIntegrationRisk({
    contractDiff: diffContracts({ before: [], after: [], changedPaths: ["src/mystery.ts"] }),
  });
  assert.equal(unverified.signals[0]?.code, "contract-unverified");
  assert.equal(unverified.level, "review-required");

  const db = evaluateIntegrationRisk({
    contractDiff: diffContracts({
      before: [{ path: "db/schema.sql", text: "CREATE TABLE users (id INTEGER, email TEXT);" }],
      after: [{ path: "db/schema.sql", text: "CREATE TABLE users (id INTEGER);" }],
    }),
  });
  assert.equal(db.level, "human-review");
  assert.equal(db.signals[0]?.code, "db-contract");
  assert.equal(db.human_review_required, true);

  const security = evaluateIntegrationRisk({ contractDiff: breakingDiff("src/auth/session.ts") });
  assert.equal(security.signals[0]?.code, "security-contract", "sensitivity comes from the canonical human-review rules");
  assert.equal(security.level, "human-review");
});

test("evaluateIntegrationRisk: konfliktai, multi-module ir determinizmas", () => {
  const first = evaluateIntegrationRisk({
    contractDiff: emptyDiff(),
    conflicts: [{ id: "c1", paths: ["src/x.ts"], tasks: ["0001", "0002"], attempts: 1 }],
  });
  assert.equal(first.signals[0]?.code, "merge-conflict");
  assert.equal(first.level, "review-required");

  const repeated = evaluateIntegrationRisk({
    contractDiff: emptyDiff(),
    conflicts: [{ id: "c1", paths: ["src/x.ts"], attempts: 2 }],
  });
  assert.equal(repeated.signals[0]?.code, "repeated-conflict");
  assert.equal(repeated.level, "human-review");

  const multi = evaluateIntegrationRisk({
    contractDiff: breakingDiff("src/shared/contract.ts"),
    modulesByPath: { "src/shared/contract.ts": "shared" },
  });
  assert.ok(!multi.signals.some((signal) => signal.code === "multi-module-contract"), "one module is not multi-module");

  const a = evaluateIntegrationRisk({ contractDiff: breakingDiff() });
  const b = evaluateIntegrationRisk({ contractDiff: breakingDiff() });
  assert.equal(a.verdict_hash, b.verdict_hash, "same inputs → same verdict identity");
});

// ---------------------------------------------------------------------------
// reviewIntegration
// ---------------------------------------------------------------------------

function reviewScope(diff: ContractDiffReport) {
  return { taskId: "0007", waveId: "w1", contractDiff: diff };
}

test("reviewIntegration: routine nekviečia, hard gate ir trūkstamas reviewer'is parkuoja", async () => {
  const routineRisk = evaluateIntegrationRisk({ contractDiff: emptyDiff() });
  const noReview = await reviewIntegration({ risk: routineRisk, scope: reviewScope(emptyDiff()) });
  assert.equal(noReview.status, "no-review");
  assert.equal(noReview.llm_invoked, false);

  const hardRisk = evaluateIntegrationRisk({
    contractDiff: emptyDiff(),
    conflicts: [{ id: "c1", paths: ["src/x.ts"], attempts: 2 }],
  });
  const hard = await reviewIntegration({ risk: hardRisk, scope: reviewScope(emptyDiff()) });
  assert.equal(hard.status, "human-review");
  assert.equal(hard.llm_invoked, false, "human-review level never spends an LLM call");
  assert.ok(hard.alternatives.length > 0, "alternatives are concrete actions, never empty");

  const reviewRisk = evaluateIntegrationRisk({ contractDiff: breakingDiff() });
  const noReviewer = await reviewIntegration({ risk: reviewRisk, scope: reviewScope(breakingDiff()) });
  assert.equal(noReviewer.status, "human-review", "absence of a reviewer never becomes approval");
});

test("reviewIntegration: biudžetas, verdiktai ir usage apskaita per fake portus", async () => {
  const risk = evaluateIntegrationRisk({ contractDiff: breakingDiff() });
  const scope = reviewScope(breakingDiff());
  const usageEntries: { outcome: string; model: string }[] = [];
  const usagePort = {
    record: async (entry: { model: string; outcome: "succeeded" | "failed" }) => {
      usageEntries.push({ outcome: entry.outcome, model: entry.model });
    },
  };

  const denied = await reviewIntegration({
    risk,
    scope,
    deps: {
      reviewer: { review: async () => ({ verdict: "approve", summary: "", findings: [] }) },
      budget: { authorize: async () => ({ allowed: false, reasons: ["cap"] }) },
    },
  });
  assert.equal(denied.status, "human-review");
  assert.equal(denied.llm_invoked, false, "unauthorized call never happens");

  const approve = await reviewIntegration({
    risk,
    scope,
    deps: {
      reviewer: { review: async () => ({ verdict: "approve", summary: "ok", findings: [] }) },
      budget: { authorize: async () => ({ allowed: true, reasons: [] }) },
      usage: usagePort,
    },
  });
  assert.equal(approve.status, "approved");
  assert.equal(approve.llm_invoked, true);
  assert.match(approve.prompt_hash ?? "", /^ip1:[0-9a-f]{16}$/);

  const changes = await reviewIntegration({
    risk,
    scope,
    deps: {
      reviewer: {
        review: async (): Promise<IntegrationReviewerResponse> => ({
          verdict: "changes-required",
          summary: "fix the import",
          findings: [{ target: "ts-export:src/api.ts#removedThing", detail: "consumer breaks", paths: ["src/api.ts"] }],
        }),
      },
    },
  });
  assert.equal(changes.status, "repair-required");
  assert.equal(changes.findings.length, 1);

  const failed = await reviewIntegration({
    risk,
    scope,
    deps: {
      reviewer: {
        review: async () => {
          throw new Error("model unavailable");
        },
      },
      usage: usagePort,
    },
  });
  assert.equal(failed.status, "human-review");
  assert.equal(failed.llm_invoked, true, "a failed call is still an audited call");
  assert.deepEqual(
    usageEntries.map((entry) => entry.outcome),
    ["succeeded", "failed"],
    "usage is recorded for both outcomes",
  );
});

test("parseIntegrationReviewResponse ir prompt'o aiškus apkarpymas", () => {
  const wrapped = parseIntegrationReviewResponse('Here you go:\n{"verdict":"approve","summary":"fine"}\nthanks');
  assert.equal(wrapped.verdict, "approve");
  assert.equal(parseIntegrationReviewResponse("plain prose").verdict, "escalate");
  const unknown = parseIntegrationReviewResponse({ verdict: "maybe" });
  assert.equal(unknown.verdict, "escalate");
  assert.match(unknown.summary, /unknown reviewer verdict/);

  const manyExports = Array.from({ length: 20 }, (_, index) => `export const removed${index} = 1;`).join("\n");
  const bigDiff = diffContracts({ before: [{ path: "src/big.ts", text: manyExports }], after: [{ path: "src/big.ts", text: "" }] });
  const risk = evaluateIntegrationRisk({ contractDiff: bigDiff });
  const prompt = buildIntegrationReviewPrompt(risk, reviewScope(bigDiff));
  assert.match(prompt, new RegExp(`apimtis apkarpyta ties ${MAX_PROMPT_CONTRACTS}`), "truncation is announced, never silent");
});

// ---------------------------------------------------------------------------
// createIntegrationRepair
// ---------------------------------------------------------------------------

test("createIntegrationRepair: fail-closed atsisakymai ir siauro repair kūnas", () => {
  const base = {
    taskId: "0007",
    waveId: "w1",
    taskAllowedPaths: ["src/a/**"],
    targetedTests: ["src/tests/cross.test.ts"],
  };

  const repeated = createIntegrationRepair({ ...base, conflict: { id: "c1", paths: ["src/a/x.ts"], attempts: 2 } });
  assert.equal(repeated.kind, "human-review");

  const noPaths = createIntegrationRepair({ ...base, conflict: { id: "c1", paths: [] } });
  assert.equal(noPaths.kind, "human-review");

  const outOfScope = createIntegrationRepair({ ...base, conflict: { id: "c1", paths: ["src/b/x.ts"] } });
  assert.equal(outOfScope.kind, "human-review", "a conflict outside the task scope is never repaired narrowly");

  const noTests = createIntegrationRepair({ ...base, targetedTests: [], conflict: { id: "c1", paths: ["src/a/x.ts"] } });
  assert.equal(noTests.kind, "human-review", "without a targeted test a repair cannot be proven");

  const ok = createIntegrationRepair({ ...base, conflict: { id: "c1", paths: ["src/a/x.ts"], summary: "export collision" } });
  assert.equal(ok.kind, "repair");
  if (ok.kind !== "repair") return;
  assert.deepEqual(ok.repair.allowed_paths, ["src/a/x.ts"], "allowed paths are the conflict paths, not the task scope");
  assert.equal(ok.repair.agent, "repairer");
  assert.match(ok.repair.repair_hash, /^irp1:[0-9a-f]{16}$/);
  for (const section of ["# Repair Task", "## Tikslas", "## Agentas", "## Klaida", "## Failai", "## Veiksmas", "## Patikra", "## Stop", "## Neįtraukta"]) {
    assert.ok(ok.repair.body.includes(section), `repair body carries the canonical section ${section}`);
  }
});

test("conflictForIntegrationRepair išveda konfliktą iš taisytino signalo", () => {
  const risk = evaluateIntegrationRisk({ contractDiff: breakingDiff() });
  const derived = conflictForIntegrationRepair(risk);
  assert.ok(derived, "a repairable signal yields a derived conflict");
  assert.equal(derived?.attempts, 1);

  const explicit = conflictForIntegrationRepair(
    { ...risk, focus: { ...risk.focus, conflicts: ["c9"] } },
    [{ id: "c9", paths: ["src/x.ts"] }],
  );
  assert.equal(explicit?.id, "c9", "an explicit wave conflict always wins");
});

// ---------------------------------------------------------------------------
// collectTaskIntegrationEvidence
// ---------------------------------------------------------------------------

test("collectTaskIntegrationEvidence: reader semantika ir paskelbtas apkarpymas", async () => {
  const revisions = new Map<string, ContractRevisionFile>([
    ["base:src/kept.ts", { present: true, text: "export const kept = 1;" }],
    ["head:src/kept.ts", { present: true, text: "export const kept = 1;\nexport const extra = 2;" }],
    ["base:src/new.ts", { present: false }],
    ["head:src/new.ts", { present: true, text: "export const fresh = 1;" }],
  ]);
  const collected = await collectTaskIntegrationEvidence({
    baseRef: "base",
    headRef: "head",
    changedPaths: ["src/kept.ts", "src/new.ts", "docs/readme.md"],
    readFile: async (ref, filePath) => revisions.get(`${ref}:${filePath}`) ?? { present: false },
  });
  assert.deepEqual(collected.contractPaths, ["src/kept.ts", "src/new.ts"], "non contract-bearing paths are excluded");
  assert.equal(collected.evidence.contractDiff.compatible, true, "additions alone do not block");
  assert.match(summarizeTaskIntegrationEvidence(collected), /^paths=2 contracts=\d+ blocking=0 unverified=0 diff=cd1:/);

  const truncated = await collectTaskIntegrationEvidence({
    baseRef: "base",
    headRef: "head",
    changedPaths: ["src/kept.ts", "src/new.ts"],
    maxContentPaths: 1,
    readFile: async (ref, filePath) => revisions.get(`${ref}:${filePath}`) ?? { present: false },
  });
  assert.deepEqual(truncated.contentTruncatedPaths, ["src/new.ts"]);
  assert.ok(
    truncated.evidence.contractDiff.unverified_paths.includes("src/new.ts"),
    "the truncated path becomes unverified, never silently compatible",
  );
  assert.match(summarizeTaskIntegrationEvidence(truncated), /content_truncated=1$/);
});

// ---------------------------------------------------------------------------
// runWaveGates
// ---------------------------------------------------------------------------

const FULL_GATES: WaveGatePolicy = {
  typecheck: { cmd: "pnpm", args: ["typecheck"] },
  lint: { cmd: "pnpm", args: ["lint"] },
  architecture: { cmd: "pnpm", args: ["arch"] },
  "integration-tests": { cmd: "pnpm", args: ["test"] },
  build: { cmd: "pnpm", args: ["build"] },
};

function fakeDeps(options: {
  failGate?: string;
  blockArg?: string;
  onRun?: (display: string, env: NodeJS.ProcessEnv) => void;
}): { deps: RunWaveGatesDeps; persisted: WaveGateReport[] } {
  const persisted: WaveGateReport[] = [];
  const deps: RunWaveGatesDeps = {
    runner: async (command, _cwd, env) => {
      options.onRun?.(command.display, env);
      const code = options.failGate === command.gate ? 1 : 0;
      return { code, stdout: "", stderr: "" };
    },
    commandPolicy: (_cmd, args) =>
      options.blockArg !== undefined && args[0] === options.blockArg ? { blockedPattern: `blocked:${options.blockArg}` } : {},
    store: {
      persist: async (report) => {
        persisted.push(report);
      },
    },
  };
  return { deps, persisted };
}

function waveInput(gates: WaveGatePolicy) {
  return {
    projectRoot: "D:/tmp/vq-wave",
    runId: "run-1",
    waveId: "w1",
    branch: "ag/integration/run-1/w1",
    head: "f".repeat(40),
    contractDiff: emptyDiff(),
    tasks: [{ task_id: "0001", impacted_tests: ["src/tests/a.test.ts"], changed_paths: ["src/a.ts"] }],
    gates,
    baseEnv: {},
    now: (() => {
      let tick = 0;
      return () => (tick += 10);
    })(),
    timestamp: () => "2026-08-19T10:00:00.000Z",
  };
}

test("runWaveGates: žalia banga — vidinis contract vartas, testų atranka ir persistuotas įrodymas", async () => {
  const seenEnv: NodeJS.ProcessEnv[] = [];
  const { deps, persisted } = fakeDeps({ onRun: (_display, env) => seenEnv.push(env) });
  const report = await runWaveGates(waveInput(FULL_GATES), deps);

  assert.equal(report.ok, true, report.blocking_reasons.join("; "));
  assert.equal(report.gates.length, 6, "all six gates are reported, contract-compatibility included");
  assert.equal(report.gates.find((gate) => gate.gate === "contract-compatibility")?.status, "passed");
  assert.deepEqual(report.selected_tests, ["src/tests/a.test.ts"]);
  assert.equal(seenEnv[0]?.[WAVE_TESTS_ENV], "src/tests/a.test.ts", "selection travels via env, not argv");
  assert.match(report.source_hash, /^wg1:[0-9a-f]{16}$/);
  assert.equal(persisted.length, 1, "the report evidence is persisted through the store port");
});

test("runWaveGates: missing vartas yra ne-praėjimas, lūžis praleidžia likusius, politika blokuoja", async () => {
  const onlyTypecheck: WaveGatePolicy = { typecheck: { cmd: "pnpm", args: ["typecheck"] } };
  const missing = await runWaveGates(waveInput(onlyTypecheck), fakeDeps({}).deps);
  assert.equal(missing.ok, false, "a passing typecheck cannot compensate for unconfigured gates");
  assert.ok(missing.blocking_reasons.some((reason) => reason.startsWith("missing-gate: lint")));
  assert.equal(missing.gates.find((gate) => gate.gate === "build")?.status, "missing");

  const failing = await runWaveGates(waveInput(FULL_GATES), fakeDeps({ failGate: "typecheck" }).deps);
  assert.equal(failing.gates.find((gate) => gate.gate === "typecheck")?.status, "failed");
  assert.equal(failing.gates.find((gate) => gate.gate === "lint")?.status, "skipped", "later gates are skipped, not hidden");
  assert.ok(failing.blocking_reasons.some((reason) => reason === "gate-failed: typecheck exited 1"));

  const blocked = await runWaveGates(waveInput(FULL_GATES), fakeDeps({ blockArg: "lint" }).deps);
  const lint = blocked.gates.find((gate) => gate.gate === "lint");
  assert.equal(lint?.status, "blocked");
  assert.equal(lint?.exit_code, 126);
  assert.ok(blocked.blocking_reasons.some((reason) => reason.startsWith("gate-blocked: lint")));
});

test("selectWaveTests: sąjunga su kontraktus dengiančiais testais", () => {
  const diff = breakingDiff("src/api.ts");
  const selected = selectWaveTests(
    [{ task_id: "0001", impacted_tests: ["src/tests/a.test.ts"] }],
    diff,
    { "src/api.ts": ["src/tests/api-consumer.test.ts"] },
  );
  assert.deepEqual(selected, ["src/tests/a.test.ts", "src/tests/api-consumer.test.ts"]);
});
