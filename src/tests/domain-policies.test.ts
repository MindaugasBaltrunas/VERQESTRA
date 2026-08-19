// VQ-203: domain/policies kontraktų testai — enforcement matrica, file-length ratchet,
// commit-message WIP žymė, stack matrica, agent parse/validate, task klasifikacija.
// Elgesio atvejai perkelti iš AG_loop atitinkamų unit suite'ų branduolio.
import assert from "node:assert/strict";
import test from "node:test";
import { decideEnforcement } from "../domain/policies/enforcement-level.js";
import {
  evaluateFileLengths,
  fileLengthVerdict,
  findStaleFileLengthBaselineEntries,
} from "../domain/policies/file-length.js";
import {
  WIP_TASK_TRAILER,
  commitTitleFromFiles,
  fallbackCommitBody,
  isWipCommitMessage,
} from "../domain/policies/commit-message.js";
import { deriveStackDecision, KNOWN_STYLES } from "../domain/policies/stack-decision-matrix.js";
import type { StackSignals } from "../domain/policies/stack-decision.js";
import { parseAgentBlock, validateAgentSelection, effectiveAgentRole, resolveAgentModelHint, parseAgentChain } from "../domain/policies/agent-selection.js";
import { defaultAgentPolicy } from "../domain/policies/agent-policy-defaults.js";
import { classifyTask, pathFragmentMatches } from "../domain/policies/task-classification.js";
import { defaultTaskClassificationPolicy } from "../domain/policies/task-classification-defaults.js";
import { detectForbiddenDependencyViolations } from "../domain/policies/architecture-style.js";
import {
  deprecatedModelPolicyFields,
  modelAllowed,
  modelPolicyRoutingSection,
  type ModelPolicy,
} from "../domain/policies/model-policy-rules.js";

function signalsOf(overrides: Partial<StackSignals>): StackSignals {
  return {
    appType: "api-only",
    uiNodeIds: [],
    apiNodeIds: ["a1", "a2", "a3"],
    dataNodeIds: [],
    integrationNodeIds: [],
    complexity: { nodeCount: 3, edgeCount: 2, externalNodeCount: 0, level: "low" },
    deploymentHints: [],
    riskHints: [],
    ...overrides,
  };
}

test("enforcement matrix: advisory never acts, possible never blocks, confirmed follows level", () => {
  assert.deepEqual(decideEnforcement("advisory", "confirmed"), { effect: "none", reason_kind: "none" });
  assert.deepEqual(decideEnforcement("block", "possible"), { effect: "review", reason_kind: "possible" });
  assert.deepEqual(decideEnforcement("block", "confirmed"), { effect: "block", reason_kind: "confirmed" });
  assert.deepEqual(decideEnforcement("warn", "confirmed"), { effect: "review", reason_kind: "confirmed" });
});

test("file-length ratchet: limit, frozen baseline, stale entries, confirmed verdict", () => {
  const measurements = [
    { file: "a.ts", lines: 400 },
    { file: "b.ts", lines: 700 },
    { file: "c.ts", lines: 745 },
  ];
  const baseline = { "c.ts": 744, "gone.ts": 900, "small.ts": 600 };
  assert.deepEqual(evaluateFileLengths(measurements, 500, baseline), [
    { file: "b.ts", lines: 700, allowed: 500 },
    { file: "c.ts", lines: 745, allowed: 744 },
  ]);
  const stale = findStaleFileLengthBaselineEntries([...measurements, { file: "small.ts", lines: 100 }], 500, baseline);
  assert.deepEqual(stale, [
    { file: "gone.ts", baseline: 900, reason: "missing-file" },
    { file: "small.ts", baseline: 600, reason: "within-limit" },
  ]);
  assert.deepEqual(fileLengthVerdict("block", []), { effect: "none", reason_kind: "none" });
  assert.deepEqual(fileLengthVerdict("block", [{ file: "b.ts", lines: 700, allowed: 500 }]), {
    effect: "block",
    reason_kind: "confirmed",
  });
});

test("commit-message: title scopes, WIP trailer strictness and body wiring", () => {
  assert.equal(commitTitleFromFiles([]), "chore: atnaujinti failai");
  assert.equal(commitTitleFromFiles(["AG/tasks/0001-x.md"]), "chore(AG/tasks): 0001-x.md");
  assert.equal(
    commitTitleFromFiles(["apps/web/App.tsx", "apps/web/api.ts", "modules/x/y.ts", "apps/web/z.ts", "apps/web/w.ts"]),
    "feat(apps/web +1): App.tsx, api.ts, y.ts (+2 failų)",
  );
  const body = fallbackCommitBody(["a.ts"], "0042-task");
  assert.match(body, new RegExp(`^${WIP_TASK_TRAILER}: 0042-task$`, "m"));
  assert.ok(isWipCommitMessage(body));
  assert.ok(!isWipCommitMessage(`Žymė „${WIP_TASK_TRAILER}: 0042" viduryje prozos neveikia`));
  assert.equal(fallbackCommitBody(["a.ts"], "blogas id su tarpu"), "- a.ts", "netinkamas id => be žymės");
});

test("stack matrix: inference branches, explicit authority, conflict and risk gates", () => {
  const apiOnly = deriveStackDecision(signalsOf({}));
  assert.equal(apiOnly.architectureStyle, "layered");
  assert.equal(apiOnly.confidence, "high");
  assert.equal(apiOnly.humanReviewRequired, false);
  assert.equal(apiOnly.alternativesConsidered.length, KNOWN_STYLES.length - 1);

  const unknown = deriveStackDecision(signalsOf({ appType: "unknown" }));
  assert.equal(unknown.confidence, "low");
  assert.equal(unknown.selectedLanguage, null);

  const dataDominant = deriveStackDecision(
    signalsOf({ appType: "fullstack", dataNodeIds: ["d1", "d2", "d3", "d4"], apiNodeIds: ["a1"], uiNodeIds: ["u1"] }),
  );
  assert.equal(dataDominant.architectureStyle, "pipeline");

  const fullyExplicit = deriveStackDecision(signalsOf({}), {
    language: "go",
    framework: "chi",
    architectureStyle: "hexagonal",
  });
  assert.equal(fullyExplicit.confidence, "high");
  assert.deepEqual(fullyExplicit.alternativesConsidered, []);
  assert.equal(fullyExplicit.humanReviewRequired, false);

  const conflicting = deriveStackDecision(signalsOf({}), { language: "go" });
  assert.equal(conflicting.humanReviewRequired, true, "explicit-vs-inferred conflict routes to human review");

  const risky = deriveStackDecision(signalsOf({ riskHints: ["risk:auth"] }));
  assert.equal(risky.humanReviewRequired, true);
  const deploy = deriveStackDecision(signalsOf({ deploymentHints: ["deployment:docker"] }));
  assert.equal(deploy.humanReviewRequired, true);
});

test("agent selection: chain parsing, kv form, validation and model hint resolution", () => {
  assert.deepEqual(parseAgentChain("readme-guard -> `coder` → reviewer, tester"), [
    "readme-guard",
    "coder",
    "reviewer",
    "tester",
  ]);
  assert.deepEqual(parseAgentChain("coder. paaiškinimas sakinyje"), ["coder"]);

  const selection = parseAgentBlock("# Task\n\n## Agentai\nreadme-guard -> coder -> reviewer\nmodel_hint: opus\n");
  assert.equal(selection.primary, "readme-guard");
  assert.deepEqual(selection.supporting, ["coder", "reviewer"]);
  assert.equal(resolveAgentModelHint(selection, defaultAgentPolicy), "opus");
  assert.equal(effectiveAgentRole(selection, defaultAgentPolicy), "coder", "readme-guard nėra darbinis primary");
  assert.deepEqual(validateAgentSelection(selection, defaultAgentPolicy), []);

  const empty = parseAgentBlock("# Task\n\n## Tikslas\nT");
  assert.deepEqual(validateAgentSelection(empty, defaultAgentPolicy), ["## Agentai: nenurodytas joks vaidmuo"]);
  const unknownRole = parseAgentBlock("# Task\n\n## Agentai\nkeistas-vaidmuo\n");
  assert.deepEqual(validateAgentSelection(unknownRole, defaultAgentPolicy), [
    "## Agentai: nerasta žinomo vaidmens (keistas-vaidmuo)",
  ]);
});

test("task classification: scope-driven paths, segment boundaries, aggregation", () => {
  const routine = classifyTask("Fix typo in README", ["README.md"], defaultTaskClassificationPolicy);
  assert.deepEqual(routine.categories, ["routine"]);
  assert.equal(routine.model_policy_hint, "haiku");

  const data = classifyTask("Add users table", ["db/migrations/0001.sql"], defaultTaskClassificationPolicy);
  assert.ok(data.categories.includes("data"));
  assert.equal(data.sensitivity, "high");
  assert.equal(data.model_policy_hint, "opus");

  assert.ok(pathFragmentMatches("ag/config/policy/x.json", "policy"));
  assert.ok(pathFragmentMatches("src/policy-utils.ts", "policy"), "brūkšnys yra žodžio riba (etalono elgesys)");
  assert.ok(pathFragmentMatches("security-policy.json", "security"));
  assert.ok(!pathFragmentMatches("mysecurity.ts", "security"), "žodžio vidurys — ne atitikmuo");
});

test("model-policy rules: tier membership, deprecated-field presence, raw routing passthrough", () => {
  const policy: ModelPolicy = { tiers: ["haiku", "sonnet"], escalation: {}, routing: { default: "sonnet" } };
  assert.ok(modelAllowed(policy, " sonnet "));
  assert.ok(!modelAllowed(policy, "opus"));
  assert.deepEqual(deprecatedModelPolicyFields(policy), ["escalation"], "tikrinamas rakto buvimas, ne truthiness");
  assert.deepEqual(deprecatedModelPolicyFields({ tiers: [] }), []);
  assert.deepEqual(modelPolicyRoutingSection(policy), { default: "sonnet" });
  assert.equal(modelPolicyRoutingSection({ tiers: [] }), undefined);
});

test("architecture-style evidence grading: scope confirmed, graph confirmed, text possible, none silent", () => {
  const policy = { forbidden_dependencies: ["apps/web -> packages/db", "legacy/module"] };
  const scoped = detectForbiddenDependencyViolations(policy, ["packages/db/client.ts"]);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]?.evidence, "confirmed");
  assert.equal(scoped[0]?.file, "packages/db/client.ts");

  const graph = detectForbiddenDependencyViolations(policy, [], {
    codeGraphEdges: ["apps/web/home.ts -> packages/db/client.ts"],
  });
  assert.equal(graph[0]?.evidence, "confirmed");
  assert.equal(graph[0]?.file, null);

  const text = detectForbiddenDependencyViolations(policy, [], { taskText: "nekeisti apps/web sluoksnio" });
  assert.equal(text[0]?.evidence, "possible");

  const silent = detectForbiddenDependencyViolations(policy, ["src/other.ts"], { taskText: "niekas nesusiję" });
  assert.deepEqual(silent, []);
  assert.deepEqual(
    detectForbiddenDependencyViolations(policy, [], { taskText: "žodis myapps/website viduje" }),
    [],
    "substring be kelio ribos nėra įrodymas",
  );
});
