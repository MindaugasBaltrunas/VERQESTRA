// VQ-305 (2/3-b): preflight kelio unit testai — policy loaderiai per fake portą (default'ai
// trūkstant failo, fail-fast blogam JSON/nežinomam raktui), architektūros/enforcement vartų
// matrica (trijų pakopų įrodymai) ir evaluatePreflight seka su fake portais. Jokio realaus FS.
import assert from "node:assert/strict";
import test from "node:test";
import { PolicyConfigError } from "../shared/errors.js";
import {
  loadArchitectureStylePolicy,
  loadCodingPrinciplesPolicy,
  loadEnforcementPolicy,
} from "../application/policy-governance/architecture-policies.js";
import { loadTaskClassificationPolicy } from "../application/policy-governance/task-classification-policy.js";
import { defaultTaskClassificationPolicy } from "../domain/policies/task-classification-defaults.js";
import {
  DEFAULT_PREFLIGHT_LIMITS,
  loadPreflightLimits,
  mergePreflightLimits,
  readPreflightLimitsFile,
} from "../application/policy-governance/preflight-limits-policy.js";
import { DEFAULT_TURN_LIMITS, resolveMaxTurns } from "../application/token-governance/turn-budget.js";
import { evaluateArchitectureAndPolicyGates } from "../application/quality-gates/preflight-rules.js";
import {
  evaluatePreflight,
  requiresFreshCodeIndex,
  specSourceCandidates,
  type PreflightDecision,
  type PreflightPolicies,
  type PreflightPorts,
} from "../application/quality-gates/preflight.js";
import { classifyTask } from "../domain/policies/task-classification.js";
import type { AgentPolicy } from "../domain/policies/agent-selection.js";

function fakeFs(files: Record<string, string>): { readTextFileIfExists: (p: string) => Promise<string | undefined> } {
  const map = new Map(Object.entries(files));
  return { readTextFileIfExists: async (p) => map.get(p.replace(/\\/g, "/")) };
}

test("architecture/coding/enforcement loaderiai: trūkstamas failas → default'ai, blogas JSON → klaida", async () => {
  const empty = fakeFs({});
  const style = await loadArchitectureStylePolicy(empty, "/repo/vq");
  assert.equal(style.strictness, "advisory");
  assert.deepEqual(style.forbidden_dependencies, []);
  const principles = await loadCodingPrinciplesPolicy(empty, "/repo/vq");
  assert.equal(principles.single_responsibility, "advisory");
  const enforcement = await loadEnforcementPolicy(empty, "/repo/vq");
  assert.equal(enforcement.max_files_per_task, 10);
  assert.equal(enforcement.broad_scope_requires_human_review, true);

  const broken = fakeFs({ "/repo/vq/architecture/enforcement-policy.json": "{ blogas" });
  await assert.rejects(() => loadEnforcementPolicy(broken, "/repo/vq"), /not valid JSON/);

  const configured = fakeFs({
    "/repo/vq/architecture/architecture-style.json": JSON.stringify({
      strictness: "block",
      forbidden_dependencies: ["ui -> database"],
    }),
  });
  const strict = await loadArchitectureStylePolicy(configured, "/repo/vq");
  assert.equal(strict.strictness, "block");
});

test("task-classification loaderis: trūkstamas failas → domain default'ai; failas laimi prieš kodą", async () => {
  assert.equal(await loadTaskClassificationPolicy(fakeFs({}), "/repo/vq"), defaultTaskClassificationPolicy);
  const custom = {
    ...defaultTaskClassificationPolicy,
    version: "9.9.9",
  };
  const fs = fakeFs({ "/repo/vq/config/task-classification-policy.json": JSON.stringify(custom) });
  const loaded = await loadTaskClassificationPolicy(fs, "/repo/vq");
  assert.equal(loaded.version, "9.9.9");
  await assert.rejects(
    () => loadTaskClassificationPolicy(fakeFs({ "/repo/vq/config/task-classification-policy.json": "{}" }), "/repo/vq"),
    /version is required/,
  );
});

test("preflight-limits: present/absent, nežinomas raktas = PolicyConfigError, turnLimits liejami per raktą", async () => {
  const absent = await readPreflightLimitsFile(fakeFs({}), "/repo/vq");
  assert.deepEqual(absent, { present: false, values: {} });
  assert.deepEqual(await loadPreflightLimits(fakeFs({}), "/repo/vq"), DEFAULT_PREFLIGHT_LIMITS);

  const partial = mergePreflightLimits({ maxLines: 50, turnLimits: { small: 5 } });
  assert.equal(partial.maxLines, 50);
  assert.equal(partial.maxAllowedPaths, DEFAULT_PREFLIGHT_LIMITS.maxAllowedPaths);
  assert.equal(partial.turnLimits?.small, 5);
  assert.equal(partial.turnLimits?.repair, DEFAULT_TURN_LIMITS.repair, "dalinis turnLimits nepalieka NaN");

  await assert.rejects(
    () => readPreflightLimitsFile(fakeFs({ "/repo/vq/config/preflight-limits.json": '{"nežinomas": 1}' }), "/repo/vq"),
    (error: unknown) => error instanceof PolicyConfigError,
    "nežinomas raktas — PolicyConfigError (infra, ne tylus ignoravimas)",
  );
  await assert.rejects(
    () => readPreflightLimitsFile(fakeFs({ "/repo/vq/config/preflight-limits.json": '{"turnLimits":{"small":0}}' }), "/repo/vq"),
    (error: unknown) => error instanceof PolicyConfigError,
    "turnLimits 0 neleidžiamas — jis reikštų neribotą dispatch'ą",
  );
});

// 016 (2026-08-25, optimizavimo audito P1-2): lubos NEGALI kirsti 0033 kalibracijos.
// `min(180, 120)=120` tyliai anuliavo HUMAN-REVIEW-APPROVED `large=180` — šis testas
// pin'ina, kad default lubos praleidžia pilną kalibruotą large langą.
test("preflight-limits: dispatchMaxTurns default nebekerta 0033 kalibracijos large=180", () => {
  assert.equal(DEFAULT_PREFLIGHT_LIMITS.dispatchMaxTurns, 180);
  assert.equal(
    resolveMaxTurns({
      phase: "implementation",
      tier: "large",
      ceiling: DEFAULT_PREFLIGHT_LIMITS.dispatchMaxTurns,
    }),
    DEFAULT_TURN_LIMITS.large,
    "large tier'as gauna pilną kalibruotą langą, lubos saugo tik nuo konfigo klaidos",
  );
});

const CLASSIFICATION_FEATURE = classifyTask("implement feature x", ["src/commands/x.ts"], defaultTaskClassificationPolicy);

test("architektūros/enforcement vartai: trijų pakopų įrodymai ir enforcement taisyklės", () => {
  const base = {
    taskText: "# Task\nDaryk.",
    allowedFiles: ["src/database/client.ts"],
    checks: ["pnpm test"],
    specSources: ["openspec/changes/x"],
    classification: CLASSIFICATION_FEATURE,
    enforcementPolicy: {
      require_tests_for_code_changes: false,
      max_files_per_task: 10,
      broad_scope_requires_human_review: true,
      require_interface_contract_for_public_changes: false,
    },
  };

  // confirmed + block → invalid.
  const blocked = evaluateArchitectureAndPolicyGates({
    ...base,
    architectureStylePolicy: { strictness: "block", forbidden_dependencies: ["ui -> database"] },
  });
  assert.equal(blocked.invalidReasons.length, 1);
  assert.match(blocked.invalidReasons[0]!, /architecture block: .* \(evidence: confirmed\)/);

  // confirmed + warn → review.
  const warned = evaluateArchitectureAndPolicyGates({
    ...base,
    architectureStylePolicy: { strictness: "warn", forbidden_dependencies: ["ui -> database"] },
  });
  assert.equal(warned.invalidReasons.length, 0);
  assert.match(warned.reviewReasons[0]!, /architecture warn/);

  // possible (tik teksto paminėjimas) → review net esant block.
  const possible = evaluateArchitectureAndPolicyGates({
    ...base,
    taskText: "# Task\nNeliesk database sluoksnio.",
    allowedFiles: ["src/api/x.ts"],
    architectureStylePolicy: { strictness: "block", forbidden_dependencies: ["ui -> database"] },
  });
  assert.equal(possible.invalidReasons.length, 0);
  assert.match(possible.reviewReasons[0]!, /evidence: possible/);

  // require_tests be test komandos → invalid; max_files + broad scope + contract → review.
  const enforcement = evaluateArchitectureAndPolicyGates({
    ...base,
    checks: ["pnpm lint"],
    allowedFiles: ["a", "b", "src/**"],
    architectureStylePolicy: { strictness: "advisory", forbidden_dependencies: [] },
    enforcementPolicy: {
      require_tests_for_code_changes: true,
      max_files_per_task: 2,
      broad_scope_requires_human_review: true,
      require_interface_contract_for_public_changes: true,
    },
    classification: { ...CLASSIFICATION_FEATURE, categories: ["architecture"] },
  });
  assert.deepEqual(enforcement.invalidReasons, ["require_tests_for_code_changes: no test command found in checks"]);
  assert.ok(enforcement.reviewReasons.some((reason) => reason.includes("max_files_per_task: 3 > 2")));
  assert.ok(enforcement.reviewReasons.some((reason) => reason.includes('broad path "src/**"')));
  assert.ok(enforcement.reviewReasons.some((reason) => reason.includes("require_interface_contract_for_public_changes")));
});

const CANONICAL_TASK = `# Task

## Spec source
openspec/changes/demo

## Tikslas
Sutvarkyti modulį.

## Agentai
coder

## Failai
Leidžiama:
- \`src/x.ts\`

## Veiksmas
- daryk

## Patikra
- \`pnpm test\`

## Stop
Sustoti, kai patikros praeina.

## Neįtraukta
- Kita.
`;

const AGENT_POLICY: AgentPolicy = {
  version: "1",
  default_role: "coder",
  roles: { coder: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true } },
};

function makePreflightPorts(taskText: string): {
  ports: PreflightPorts;
  decisions: PreflightDecision[];
  policies: PreflightPolicies;
} {
  const decisions: PreflightDecision[] = [];
  const policies: PreflightPolicies = {
    limits: { ...DEFAULT_PREFLIGHT_LIMITS },
    budget: { max_context_chars: 12000, max_spec_fragments: 8, max_file_fragments: 8, max_files: 8 },
    classificationPolicy: defaultTaskClassificationPolicy,
    agentPolicy: AGENT_POLICY,
    architectureStylePolicy: {
      version: "1.0",
      style: "layered",
      strictness: "advisory",
      layers: [],
      forbidden_dependencies: [],
    },
    codingPrinciplesPolicy: {
      version: "1.0",
      single_responsibility: "advisory",
      open_closed: "advisory",
      dependency_inversion: "advisory",
      interface_segregation: "advisory",
      dry: "advisory",
      yagni: "advisory",
    },
    enforcementPolicy: {
      version: "1.0",
      max_files_per_task: 10,
      max_lines_per_file: 500,
      max_responsibilities_per_task: 3,
      require_tests_for_code_changes: false,
      require_interface_contract_for_public_changes: false,
      broad_scope_requires_human_review: true,
      global_policy_changes_require_human_review: true,
    },
    };
  const ports: PreflightPorts = {
    resolveTaskFile: async (taskArg) => ({ filePath: `/repo/AG/tasks/queue/${taskArg}`, text: taskText }),
    loadPolicies: async () => policies,
    statPathKind: async (absolutePath) => (absolutePath.replace(/\\/g, "/").includes("openspec/changes/demo") ? "directory" : "absent"),
    codeIndexFreshness: async () => ({ ok: true }),
    writeDecision: async (decision) => void decisions.push(decision),
  };
  return { ports, decisions, policies };
}

test("evaluatePreflight: kanoninis task'as → pass, sprendimas persistuotas", async () => {
  const { ports, decisions } = makePreflightPorts(CANONICAL_TASK);
  const decision = await evaluatePreflight(ports, ["0042.md"], "/repo");
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.task_id, "0042");
  assert.deepEqual(decision.allowed_files, ["src/x.ts"]);
  assert.deepEqual(decision.checks, ["pnpm test"]);
  assert.equal(decision.agents?.primary, "coder");
  assert.equal(decision.token_budget.max_turns > 0, true);
  assert.equal(decisions.length, 1, "sprendimas įrašytas per portą");
});

test("evaluatePreflight: trūkstamos sekcijos/spec source → invalid su konkrečiomis priežastimis", async () => {
  const { ports } = makePreflightPorts("# Task\n## Tikslas\nX.\n");
  const decision = await evaluatePreflight(ports, ["0042.md"], "/repo");
  assert.equal(decision.verdict, "invalid");
  assert.ok(decision.reasons.includes("allowed files are missing"));
  assert.ok(decision.reasons.includes("checks are missing"));
  assert.ok(decision.reasons.includes("spec source is missing"));
  assert.ok(decision.reasons.some((reason) => reason.startsWith("missing required heading")));
});

test("evaluatePreflight: neegzistuojantis spec source ir nežinomas agento vaidmuo → invalid", async () => {
  const badSpec = CANONICAL_TASK.replace("openspec/changes/demo", "openspec/changes/nėra");
  const { ports } = makePreflightPorts(badSpec);
  const decision = await evaluatePreflight(ports, ["0042.md"], "/repo");
  assert.equal(decision.verdict, "invalid");
  assert.ok(decision.reasons.some((reason) => reason.startsWith("spec source not found")));

  const badAgent = CANONICAL_TASK.replace("## Agentai\ncoder", "## Agentai\nnežinomas-vaidmuo");
  const { ports: agentPorts } = makePreflightPorts(badAgent);
  const agentDecision = await evaluatePreflight(agentPorts, ["0042.md"], "/repo");
  assert.equal(agentDecision.verdict, "invalid");
});

test("evaluatePreflight: dydžio pažeidimas → review-needed su split planu", async () => {
  const { ports, policies } = makePreflightPorts(CANONICAL_TASK);
  policies.limits = { ...policies.limits, maxLines: 5 };
  const decision = await evaluatePreflight(ports, ["0042.md"], "/repo");
  assert.equal(decision.verdict, "review-needed");
  assert.ok(decision.reasons.some((reason) => reason.startsWith("lines ")));
  assert.ok(decision.split_plan, "split planas pridėtas");
  assert.ok(decision.reasons.some((reason) => reason.startsWith("split plan generated")));
});

test("spec source kandidatai ir code-index trigeris", () => {
  const candidates = specSourceCandidates("/repo", "openspec/changes/demo");
  assert.equal(candidates.length, 2, "openspec/ gauna ir AG/ prefikso variantą");
  assert.deepEqual(specSourceCandidates("/repo", "../evil"), []);
  assert.deepEqual(specSourceCandidates("/repo", "/absolute"), []);

  assert.equal(requiresFreshCodeIndex("naudok code graph context"), true);
  assert.equal(requiresFreshCodeIndex("code graph context + code-index build"), false);
  assert.equal(requiresFreshCodeIndex("paprastas taskas"), false);
});
