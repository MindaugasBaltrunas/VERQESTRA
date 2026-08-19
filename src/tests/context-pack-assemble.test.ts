// VQ-302 (2 dalis): assembleContextPack integracinis testas realioje tmp darbo kopijoje —
// pilnas kelias: task parse → policy defaults → code index rebuild → spec fragmentai →
// vienas biudžeto sprendimas → persist su fingerprint antrašte ir telemetrija. Plius
// policy loader'ių ir token optimizatoriaus unit patikros.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleContextPack } from "../application/context-pack/assemble/assemble.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { parseExecutionContextMetadata, contextArtifactSha256 } from "../application/context-pack/execution-context-fingerprint.js";
import { computeContextCacheKey } from "../application/context-pack/context-cache-key.js";
import { loadContextBudget, DEFAULT_CONTEXT_BUDGET } from "../application/policy-governance/context-budget.js";
import { loadContextSelectionPolicy, selectGraphFirstContext, DEFAULT_CONTEXT_SELECTION_LIMITS } from "../application/policy-governance/context-selection-policy.js";
import { loadAgentPolicy } from "../application/policy-governance/agent-policy.js";
import { loadContextPackToolFlags } from "../application/policy-governance/tool-budget-config.js";
import { optimizeTokenBudget, structuralTaskTier } from "../application/token-governance/token-budget-optimizer.js";
import { resolveMaxTurns, resolveDispatchTimeoutMs, DEFAULT_TURN_LIMITS, MIN_DISPATCH_TIMEOUT_MS } from "../application/token-governance/turn-budget.js";
import { decideCheapFinish, isCheapFinishWaivedBudgetReason } from "../application/token-governance/cheap-finish.js";
import { measureTaskSize } from "../domain/tasks/size.js";
import { classifyTask } from "../domain/policies/task-classification.js";
import { defaultTaskClassificationPolicy } from "../domain/policies/task-classification-defaults.js";
import { defaultAgentPolicy } from "../domain/policies/agent-policy-defaults.js";
import { nodeContextPackFsPort, nodeFsTestPort } from "./helpers/node-fs-port.js";

const TASK_MARKDOWN = [
  "# Task",
  "",
  "## Spec source",
  "doc/spec.md#alfa",
  "",
  "## Tikslas",
  "Įgyvendinti demo modulio pakeitimą.",
  "",
  "## Agentai",
  "readme-guard -> coder -> tester",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "Draudžiama:",
  "- `.env*`",
  "",
  "## Veiksmas",
  "- Pakeisti eksportą.",
  "- Padengti testu.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai patikros žalios, sustok.",
  "",
].join("\n");

test("assembleContextPack: full path over a real workspace, deterministic re-run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-302-assemble-"));
  try {
    await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
    await mkdir(path.join(root, "doc"), { recursive: true });
    await mkdir(path.join(root, "src", "module"), { recursive: true });
    await writeFile(path.join(root, "AG", "tasks", "queue", "0042-demo.md"), TASK_MARKDOWN, "utf8");
    await writeFile(path.join(root, "doc", "spec.md"), "# Alfa\nalfa spec tekstas\n# Beta\nbeta\n", "utf8");
    await writeFile(
      path.join(root, "src", "module", "a.ts"),
      'export function demo(): string {\n  return "x";\n}\n',
      "utf8",
    );

    // Indeksas statomas iš anksto: abu surinkimai eina "fresh" keliu, tad determinizmo
    // palyginimas nelygina "rebuilt" pastabą turinčio pack'o su jos neturinčiu.
    await buildCodeIndex(nodeFsTestPort, root);

    const deps = { fs: nodeContextPackFsPort, codeFs: nodeFsTestPort };
    const result = await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);

    assert.equal(result.pack.task_id, "0042-demo");
    assert.equal(result.pack.goal, "Įgyvendinti demo modulio pakeitimą.");
    assert.deepEqual(result.pack.checks, ["pnpm test"]);
    assert.deepEqual(result.pack.allowed_paths, ["src/module/a.ts"]);
    assert.ok(result.pack.spec_fragments[0]?.startsWith("doc/spec.md#alfa\n"), "spec fragmentas su heading atitikmeniu");
    assert.equal(result.pack.code_context?.enabled, true, "esamas taikinys → code context su index rebuild");
    assert.ok(result.workerTaskIr, "shadow IR kompiliuojasi kanoniniam task'ui");

    // Fingerprint antraštė: task_sha256/context_pack_sha256 nuo TŲ PAČIŲ artefaktų diske.
    const executionContext = await readFile(result.executionContextPath, "utf8");
    const packJson = await readFile(result.outputPath, "utf8");
    const metadata = parseExecutionContextMetadata(executionContext);
    assert.equal(metadata?.taskId, "0042-demo");
    assert.equal(metadata?.taskSha256, contextArtifactSha256(TASK_MARKDOWN));
    assert.equal(metadata?.contextPackSha256, contextArtifactSha256(packJson));

    // Telemetrija: be cache porto — bypass.
    const metricsRaw = await readFile(path.join(root, "vq", "logs", "context-size.jsonl"), "utf8");
    const record = JSON.parse(metricsRaw.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    assert.equal(record["task_id"], "0042-demo");
    assert.equal(record["cache_status"], "bypass");

    // Determinizmas: pakartotinis surinkimas nepakitusioje kopijoje — byte-identiškas pack'as.
    const second = await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(await readFile(second.outputPath, "utf8"), packJson);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy loaders: defaults on absent files, fail-fast on invalid values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-302-policy-"));
  try {
    const runtimeRoot = path.join(root, "vq");
    assert.deepEqual(await loadContextBudget(nodeContextPackFsPort, runtimeRoot), { ...DEFAULT_CONTEXT_BUDGET });
    assert.deepEqual(
      await loadContextSelectionPolicy(nodeContextPackFsPort, runtimeRoot, { max_context_chars: 9000 }),
      { ...DEFAULT_CONTEXT_SELECTION_LIMITS, max_context_chars: 9000 },
    );
    assert.deepEqual(await loadAgentPolicy(nodeContextPackFsPort, runtimeRoot), defaultAgentPolicy);
    assert.deepEqual(await loadContextPackToolFlags(nodeContextPackFsPort, runtimeRoot), {
      browser: false,
      scraper: false,
      mcp: false,
    });

    await mkdir(path.join(runtimeRoot, "config"), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "config", "context-selection-policy.json"),
      JSON.stringify({ max_tests: 0 }),
      "utf8",
    );
    await assert.rejects(
      () => loadContextSelectionPolicy(nodeContextPackFsPort, runtimeRoot),
      /max_tests must be a positive integer/,
    );

    await writeFile(
      path.join(runtimeRoot, "config", "tool-budget.json"),
      JSON.stringify({ default: { browser: true, mcp: true, max_total_tokens: 100 } }),
      "utf8",
    );
    const deprecations: string[] = [];
    const flags = await loadContextPackToolFlags(
      {
        ...nodeContextPackFsPort,
        // Perimam deprecation kanalą netiesiogiai: flags kelias kviečia loadToolBudget su
        // default sink'u; čia užtenka flag'ų patikros, deprecation dengiamas žemiau.
      },
      runtimeRoot,
    );
    assert.deepEqual(flags, { browser: true, scraper: false, mcp: true });
    void deprecations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("token budget optimizer: tiers, votes and turn windows stay one verdict", () => {
  const smallMetrics = measureTaskSize(["## Failai", "Leidžiama:", "- `a.ts`", "## Veiksmas", "- x"].join("\n"));
  assert.equal(structuralTaskTier(smallMetrics).tier, "small");

  const routine = optimizeTokenBudget({
    metrics: smallMetrics,
    classification: classifyTask("Fix typo in README", ["README.md"], defaultTaskClassificationPolicy),
    baseBudget: { ...DEFAULT_CONTEXT_BUDGET },
  });
  assert.equal(routine.tier, "small");
  assert.equal(routine.max_context_chars, 6000);
  assert.equal(routine.max_turns, DEFAULT_TURN_LIMITS.small);
  assert.equal(routine.model_policy_hint, "haiku");

  const risky = optimizeTokenBudget({
    metrics: smallMetrics,
    classification: classifyTask("Add users table", ["db/migrations/0001.sql"], defaultTaskClassificationPolicy),
    baseBudget: { ...DEFAULT_CONTEXT_BUDGET },
  });
  assert.equal(risky.tier, "large", "high sensitivity kelia tier'ą");
  assert.equal(risky.model_policy_hint, "opus");
  assert.equal(risky.max_turns, DEFAULT_TURN_LIMITS.large);

  assert.equal(resolveMaxTurns({ phase: "repair", tier: "large" }), DEFAULT_TURN_LIMITS.repair);
  assert.equal(resolveMaxTurns({ phase: "implementation", tier: "medium", ceiling: 0 }), 0, "0 = aiškus opt-out");
  assert.ok(resolveDispatchTimeoutMs({ tier: "small" }) >= MIN_DISPATCH_TIMEOUT_MS);
  assert.equal(
    resolveDispatchTimeoutMs({ tier: "medium" }),
    DEFAULT_TURN_LIMITS.medium * 20_000 + 40 * 60 * 1000,
    "langas = turn lentelė × per-turn + overhead",
  );
});

test("cheap finish: fail-closed gates and the single-signal diagnosis rule", () => {
  const base = {
    verdict: "repair",
    diagnosisReason: "local-diagnosis: clear local issue: error TS2304: Cannot find name",
    hasUncommittedProductWork: true,
    hasCommittedProductWork: false,
    budgetVetoReason: "budget_enforcement_failed=task tokens 700000 > 600000",
    retryLimitPredicted: false,
    alreadyArmed: false,
  };
  const eligible = decideCheapFinish(base);
  assert.ok(eligible.eligible);
  if (eligible.eligible) {
    assert.equal(eligible.class, "typecheck");
    assert.equal(eligible.blockedBy, "task-budget");
    assert.equal(eligible.requiresLedgerReset, true);
    assert.equal(eligible.maxTurns, DEFAULT_TURN_LIMITS.small);
  }

  assert.equal(decideCheapFinish({ ...base, alreadyArmed: true }).eligible, false);
  assert.equal(
    decideCheapFinish({ ...base, diagnosisReason: "local-diagnosis: clear local issue: error TS1 and error TS2" }).eligible,
    false,
    "dvi klaidos nebe vienas mechaninis taisymas",
  );
  assert.equal(
    decideCheapFinish({
      ...base,
      budgetVetoReason: "budget_enforcement_failed=model not allowed: opus; task tokens 7 > 6",
    }).eligible,
    false,
    "kokybinis draudimas blokuoja — žymė nedeginama",
  );
  assert.ok(isCheapFinishWaivedBudgetReason("phase repair tokens 10 > 5"));
  assert.ok(!isCheapFinishWaivedBudgetReason("context chars 100 > 50"));
});

test("context-cache key: kind-ordered, collection-order independent fingerprint", () => {
  const a = computeContextCacheKey([
    { kind: "policy", path: "vq/config/x.json", hash: "h1" },
    { kind: "task", path: "AG/tasks/queue/1.md", hash: "h2" },
  ]);
  const b = computeContextCacheKey([
    { kind: "task", path: "AG/tasks/queue/1.md", hash: "h2" },
    { kind: "policy", path: "vq\\config\\x.json", hash: "h1" },
  ]);
  assert.equal(a.fingerprint, b.fingerprint, "tvarka ir backslash normalizacija nekeičia rakto");
  assert.notEqual(
    a.fingerprint,
    computeContextCacheKey([{ kind: "task", path: "AG/tasks/queue/1.md", hash: "PAKITO" }]).fingerprint,
  );
});
