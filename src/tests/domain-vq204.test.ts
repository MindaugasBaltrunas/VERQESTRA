// VQ-204: domain/{tokens,project,architecture,diagnosis,metrics,tool-results} kontraktų
// testai — sritys, kurių nedengia characterization fixture'ai (tie dengia dispositions,
// benchmark verdiktus ir bash digest'ą). Elgesio atvejai perkelti iš AG_loop unit suite'ų.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_ESCALATION_CEILING,
  clampRoutingTier,
  escalateRoutingTier,
  highestRoutingTier,
  isRoutingTier,
} from "../domain/tokens/routing-tier.js";
import { classifyProjectMode } from "../domain/project/mode.js";
import { resolveProjectProfile } from "../domain/project/profile.js";
import { DEFAULT_GUARD_ROOT_PATHS, resolveGuardRootPaths } from "../domain/project/guard-roots.js";
import { bootstrapCheckedBuckets, evaluateBootstrapEligibility } from "../domain/project/bootstrap.js";
import { sanitizeGraphLabel, type ArchitectureProgress } from "../domain/architecture/graph.js";
import { fromGraphSource } from "../domain/architecture/graph-import.js";
import { computeReadiness, getReadyNodes } from "../domain/architecture/readiness.js";
import {
  extractDirectoryCandidates,
  extractLabelFilenames,
  parseNodeImplementationMap,
} from "../domain/architecture/implementation-detection.js";
import { inferInterfaceContract } from "../domain/architecture/interface-inference.js";
import {
  contentExportsSymbol,
  evaluatePolicies,
  findForbiddenDistImports,
  isForbiddenPath,
  isTestFile,
  testCandidatesFor,
} from "../domain/architecture/node-verification-rules.js";
import {
  digestClaudeStreamLog,
  digestQualityGatesLog,
  retryCountsForTask,
} from "../domain/diagnosis/log-digest.js";
import { canonicalBenchmarkPhase, usageTotalsFromEntry } from "../domain/metrics/usage.js";
import { matchesTaskIdPattern } from "../domain/metrics/cases.js";
import { computeTaskMetrics, parseOutOfScopeFiles } from "../domain/metrics/task-metrics.js";
import { classifyBashCommand } from "../domain/tool-results/bash-command-class.js";
import { decideBashOutputReplacement } from "../domain/tool-results/bash-output-replacement.js";

test("routing tiers: escalation ladder, hard ceiling, explicit base above ceiling preserved", () => {
  assert.ok(isRoutingTier("advanced"));
  assert.ok(!isRoutingTier("opus"), "provider vardai nėra pakopos");
  assert.equal(AUTO_ESCALATION_CEILING, "advanced");
  assert.equal(escalateRoutingTier("routine", 0), "routine");
  assert.equal(escalateRoutingTier("routine", 1), "standard");
  assert.equal(escalateRoutingTier("routine", 99), "advanced", "critical NIEKADA nepasiekiama eskalacija");
  assert.equal(escalateRoutingTier("critical", 3), "critical", "explicit bazė virš lubų išlaikoma");
  assert.equal(escalateRoutingTier("routine", -5), "routine");
  assert.equal(escalateRoutingTier("routine", 1.9), "standard", "trupmena grindžiama žemyn");
  assert.equal(highestRoutingTier([]), "routine");
  assert.equal(highestRoutingTier(["standard", "critical", "routine"]), "critical");
  assert.equal(clampRoutingTier("critical", "advanced"), "advanced");
});

test("project mode: repair > extend > existing > new precedence", () => {
  const base = {
    hasAgWorkspace: true,
    productMarkers: [],
    sourceFiles: [],
    openSpecChanges: [],
    queuedTasks: 0,
    interruptedTasks: 0,
    humanReviewTasks: 0,
    repairPrompts: 0,
  };
  assert.equal(classifyProjectMode({ ...base, interruptedTasks: 1, productMarkers: ["package.json"] }).mode, "repair_project");
  assert.equal(classifyProjectMode({ ...base, productMarkers: ["package.json"], queuedTasks: 2 }).mode, "extend_project");
  const existing = classifyProjectMode({ ...base, hasAgWorkspace: false, sourceFiles: ["src/a.ts"] });
  assert.equal(existing.mode, "existing_project");
  assert.equal(existing.confidence, "medium", "be AG workspace pasitikėjimas krenta");
  assert.equal(classifyProjectMode({ ...base, queuedTasks: 1 }).mode, "new_project");
  assert.equal(classifyProjectMode(base).confidence, "high");
});

test("project profile: explicit always wins, unset falls back to evidence, source recorded", () => {
  const profile = resolveProjectProfile(
    { name: "iš-evidencijos", language: "typescript", sourceRoots: ["src"], forbiddenPaths: [".env"] },
    { name: "iš-operatoriaus" },
  );
  assert.deepEqual(profile.name, { value: "iš-operatoriaus", source: "explicit" });
  assert.deepEqual(profile.language, { value: "typescript", source: "inferred" });
  assert.deepEqual(profile.packageManager, { value: undefined, source: "inferred" });
  assert.deepEqual(profile.sourceRoots, { value: ["src"], source: "inferred" });
});

test("guard roots: last-segment role match, shell-unsafe roots fall back to defaults", () => {
  assert.deepEqual(resolveGuardRootPaths(undefined), DEFAULT_GUARD_ROOT_PATHS);
  const resolved = resolveGuardRootPaths(["packages/client", "srv\\api", "mobile"]);
  assert.equal(resolved.frontend, "packages/client");
  assert.equal(resolved.backend, "srv/api", "backslash normalizuojamas");
  assert.equal(resolved.mobile, "mobile");
  const unsafe = resolveGuardRootPaths(["apps/web; rm -rf /", "../api", "C:/apps/mobile"]);
  assert.deepEqual(unsafe, DEFAULT_GUARD_ROOT_PATHS, "shell metasimboliai, .. ir absoliutūs keliai atmetami");
});

test("bootstrap eligibility: all three conditions required; bucket list frozen", () => {
  assert.equal(bootstrapCheckedBuckets.length, 6);
  assert.ok(
    evaluateBootstrapEligibility({ bucketsEmpty: true, hasReadme: true, mmdSources: ["a.mmd"] }).bootstrapEligible,
  );
  assert.ok(!evaluateBootstrapEligibility({ bucketsEmpty: true, hasReadme: true, mmdSources: [] }).bootstrapEligible);
  assert.ok(!evaluateBootstrapEligibility({ bucketsEmpty: false, hasReadme: true, mmdSources: ["a.mmd"] }).bootstrapEligible);
});

test("graph import: label sanitization and input-source classification at import time", () => {
  assert.equal(sanitizeGraphLabel("Blogas\n`label` # su | žymėm"), "Blogas label su žymėm");
  assert.equal(sanitizeGraphLabel("x".repeat(200)).length, 120);
  const graph = fromGraphSource(
    {
      nodes: [
        { id: "A", label: "Git Repository" },
        { id: "B", label: "Scanner" },
      ],
      edges: [{ from: "A", to: "B", label: "feeds" }],
    },
    "doc/arch.mmd",
    "2026-08-19T00:00:00.000Z",
  );
  const inputNode = graph.nodes.find((node) => node.id === "A");
  assert.equal(inputNode?.external, true, "grynas input šaltinis pažymimas external");
  assert.equal(inputNode?.kind, "input");
  assert.equal(graph.nodes.find((node) => node.id === "B")?.external, undefined, "realus modulis nepaliestas");
});

test("readiness: SCC keeps cycles together; downstream unblocks only when the whole cycle is done", () => {
  const graph = fromGraphSource(
    {
      nodes: [
        { id: "A", label: "Alfa Service" },
        { id: "B", label: "Beta Service" },
        { id: "C", label: "Gama Service" },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
        { from: "A", to: "C" },
      ],
    },
    "doc/arch.mmd",
    "2026-08-19T00:00:00.000Z",
  );
  const nodeProgress = (status: "planned" | "done") => ({
    status,
    attempts: {},
    queued_tasks: [],
    done_tasks: [],
    implemented_files: [],
    evidence_refs: [],
  });
  const planned: ArchitectureProgress = {
    graph_hash: "h",
    nodes: { A: nodeProgress("planned"), B: nodeProgress("planned"), C: nodeProgress("planned") },
  };
  assert.deepEqual(
    getReadyNodes(graph, planned).map((node) => node.id),
    ["A", "B"],
    "ciklas pasiruošęs kartu; C laukia viso ciklo",
  );
  const afterCycleDone: ArchitectureProgress = {
    graph_hash: "h",
    nodes: { A: nodeProgress("done"), B: nodeProgress("done"), C: nodeProgress("planned") },
  };
  const readiness = computeReadiness(graph, afterCycleDone);
  assert.equal(readiness.nodes["C"]?.status, "ready");
});

test("implementation detection: node-map degrades to null, label candidates skip generic names", () => {
  assert.equal(parseNodeImplementationMap("ne json"), null);
  assert.equal(parseNodeImplementationMap('{"nodes": {"n1": {"implemented": "taip"}}}'), null);
  assert.deepEqual(parseNodeImplementationMap('{"nodes": {"n1": {"paths": ["src/a.ts"], "note": "x"}}}'), {
    nodes: { n1: { paths: ["src/a.ts"], note: "x" } },
  });
  assert.deepEqual(extractLabelFilenames("pollLoop.ts ir index.ts, dar schema.sql"), ["pollLoop.ts", "schema.sql"]);
  assert.deepEqual(extractDirectoryCandidates("@acme/database plius billing-module"), ["database", "billing-module"]);
});

test("interface inference: edges, labels, implemented files and evidence checks", () => {
  const graph = {
    source_path: "s",
    imported_at: "t",
    nodes: [],
    edges: [
      { from: "up", to: "N", label: "in-data", type: "unknown" as const },
      { from: "N", to: "down", label: "out-data", type: "unknown" as const },
    ],
  };
  const progress: ArchitectureProgress = {
    graph_hash: "h",
    nodes: {
      N: {
        status: "done",
        attempts: {},
        queued_tasks: [],
        done_tasks: [],
        implemented_files: ["src/module/handler.ts"],
        evidence_refs: [],
      },
    },
  };
  const contract = inferInterfaceContract("N", graph, progress, [
    { node_id: "N", source: "openspec", excerpt: "spec check", timestamp: "t" },
    { node_id: "N", source: "kitas", excerpt: "ignoruojama", timestamp: "t" },
  ]);
  assert.deepEqual(contract, {
    inputs: ["in-data"],
    outputs: ["out-data"],
    upstream: ["up"],
    downstream: ["down"],
    public_exports: ["handler"],
    checks: ["spec check"],
  });
});

test("node verification rules: test candidates, forbidden paths, export detection, policy grading", () => {
  assert.ok(isTestFile("src/a.test.ts"));
  assert.deepEqual(testCandidatesFor("src/x/y.ts"), [
    "src/x/y.test.ts",
    "src/x/y.spec.ts",
    "src/x/__tests__/y.test.ts",
    "src/x/tests/y.test.ts",
    "src/x/../tests/y.test.ts",
    "src/x/../__tests__/y.test.ts",
  ]);
  assert.ok(isForbiddenPath("node_modules/pkg/a.js"));
  assert.ok(isForbiddenPath("apps\\web\\dist\\x.ts"));
  assert.ok(!isForbiddenPath("src/distX/a.ts"), "segmento riba: dist tik kaip pilnas segmentas");
  assert.deepEqual(findForbiddenDistImports('import { x } from "../dist/x.js";\nimport y from "./y.js";'), ["../dist/x.js"]);
  assert.ok(contentExportsSymbol("export async function runIt() {}", "runIt"));
  assert.ok(contentExportsSymbol('export { a, mano, b } from "./x.js";', "mano"));
  assert.ok(!contentExportsSymbol("function slaptas() {}", "slaptas"));

  const nodeProgress = {
    status: "done" as const,
    attempts: {},
    queued_tasks: [],
    done_tasks: [],
    implemented_files: [],
    evidence_refs: [],
  };
  // NUKRYPIMAS NUO ETALONO (task 130, griežtinantis): etalonas dėjo KIEKVIENĄ
  // forbidden_dependencies įrašą KIEKVIENAM mazgui, netikrindamas sąsajos. Su strictness
  // "block" tai reiškė, kad nė vienas mazgas negalėjo pasiekti done, t. y. block režimas buvo
  // nenaudojamas pagal konstrukciją. Pin'as perrašytas ne todėl, kad testas per griežtas, o
  // todėl, kad pakeistas ELGESYS: blokas lieka tik ten, kur yra reali sąsaja su mazgo
  // implemented_files (gradacija — ta pati detectForbiddenDependencyViolations kaip preflight).
  const touching = { ...nodeProgress, implemented_files: ["src/ui/panel.ts"] };
  const forbidden = ["src/ui -> src/db"];
  const touched = 'Forbidden dependency: "src/ui -> src/db" — scope path "src/ui/panel.ts" is inside forbidden endpoint "src/ui"';

  const blocked = evaluatePolicies("N", touching, {
    architectureStyle: { strictness: "block", forbidden_dependencies: forbidden },
    codingPrinciples: {},
    enforcement: { require_interface_contract_for_public_changes: true },
  });
  assert.deepEqual(blocked.policy_blockers, [touched], "sąsaja + block → blocker su įrodymu");
  assert.equal(blocked.policy_warnings.length, 1, "trūkstamas interface_contract — warning");

  // Sąsajos nėra: blanket'as būtų davęs blocker'į ir sustabdęs mazgą be jokio signalo.
  const unrelated = evaluatePolicies("N", { ...nodeProgress, implemented_files: ["src/docs/page.ts"] }, {
    architectureStyle: { strictness: "block", forbidden_dependencies: forbidden },
    codingPrinciples: {},
    enforcement: { require_interface_contract_for_public_changes: false },
  });
  assert.deepEqual(unrelated.policy_blockers, [], "be sąsajos — jokio blocker'io");
  assert.deepEqual(unrelated.policy_warnings, [], "be sąsajos — ir jokio warning'o");

  const warned = evaluatePolicies("N", touching, {
    architectureStyle: { strictness: "warn", forbidden_dependencies: forbidden },
    codingPrinciples: { single_responsibility: "block" },
    enforcement: { require_interface_contract_for_public_changes: false },
  });
  assert.deepEqual(warned.policy_blockers, []);
  assert.deepEqual(warned.policy_warnings, [touched], "codingPrinciples sąmoningai neskaitoma");
});

test("diagnosis log digest: result envelope + error lines, quality-gates context, retry scoping", () => {
  const streamLog = [
    '{"type":"system","noise":true}',
    'BLOCKED: Komanda atitinka draudziama sablona',
    '{"type":"result","result":"Sesijos santrauka"}',
  ].join("\n");
  const digest = digestClaudeStreamLog(streamLog);
  assert.match(digest, /### Sesijos rezultatas\nSesijos santrauka/);
  assert.match(digest, /### Klaidų eilutės \(1\)/);
  assert.equal(digestClaudeStreamLog("   "), "(tuščias)");
  assert.ok(digestClaudeStreamLog("a".repeat(50), 10).startsWith("…(nukirpta 40 simb.)"), "uodegos klipas deklaruoja kirpimą");

  const gates = digestQualityGatesLog(
    ["ok 0", "ok 1", "exit_code: 1", "ok 3", "ok 4", "ok 5", "ok 6", "ok 7", "ok 8", "ok 9", "ok 10", "# antra komanda", "ok 12"].join("\n"),
  );
  assert.match(gates, /exit_code: 1/);
  assert.match(gates, /…/, "tarpas tarp dviejų išlaikytų blokų žymimas elipse");
  assert.ok(!gates.includes("ok 7"), "neįdomios eilutės už konteksto lango išmetamos");

  assert.equal(retryCountsForTask("", "t1"), "{}");
  assert.equal(retryCountsForTask("ne json", "t1"), "ne json", "sugadinta būsena nenutylima");
  assert.deepEqual(JSON.parse(retryCountsForTask('{"task:t1": 2, "task:kitas": 9}', "t1")), { "task:t1": 2 });
});

test("metrics units: canonical phase, task-id globs, out-of-scope parsing, task metrics", () => {
  assert.equal(canonicalBenchmarkPhase("dispatch-worker"), "dispatch");
  assert.equal(canonicalBenchmarkPhase("bootstrap-seed"), "planning");
  assert.equal(canonicalBenchmarkPhase("kita-faze"), "other");
  assert.ok(matchesTaskIdPattern("0042-fix", "00*"));
  assert.ok(!matchesTaskIdPattern("1042-fix", "00*"));
  assert.ok(matchesTaskIdPattern("a.b", "a.b") && !matchesTaskIdPattern("axb", "a.b"), "taškas — pažodinis");
  assert.deepEqual(parseOutOfScopeFiles("changed files outside allowed paths: a.ts, b.ts"), ["a.ts", "b.ts"]);
  assert.deepEqual(parseOutOfScopeFiles("kita priežastis"), []);

  const usageEntry = {
    task_id: "t",
    phase: "dispatch",
    model: "opus",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    total_cost_usd: 1,
    attempt: 1,
    num_turns: 12,
  };
  assert.equal(usageTotalsFromEntry(usageEntry).total_tokens, 135);
  assert.equal(usageTotalsFromEntry(usageEntry).billable_tokens, 35, "cache read nesiskaito billable");
  const metrics = computeTaskMetrics({
    task_id: "t",
    case_id: "case-a",
    category: "cat",
    usage: [usageEntry],
    events: [{ task_id: "t", to_state: "done", reason: "ok" }],
  });
  assert.equal(metrics.turns, 12);
  assert.equal(metrics.turns_source, "recorded");
  assert.equal(metrics.terminal_state, "done");
  assert.ok(metrics.first_pass);
  assert.ok(metrics.acceptance.accepted);
});

test("bash replacement gates: chained command, unknown fields and text payloads keep the original", () => {
  assert.equal(classifyBashCommand("pnpm --dir x test"), "test");
  assert.equal(classifyBashCommand("npm run build && npm test"), "unknown", "dvi klasės = ambiguity");

  const chained = decideBashOutputReplacement({
    toolName: "Bash",
    command: "pnpm test && node scripts/report.js",
    toolResponse: { stdout: "ℹ pass 1", stderr: "", exit_code: 0 },
  });
  assert.equal(chained.action, "keep");
  assert.equal(chained.action === "keep" ? chained.keepReason : "", "command_is_chained");

  const unknownField = decideBashOutputReplacement({
    toolName: "Bash",
    command: "pnpm test",
    toolResponse: { stdout: "ℹ pass 1", stderr: "", exit_code: 0, naujas_laukas: true },
  });
  assert.equal(unknownField.action === "keep" ? unknownField.keepReason : "", "unknown_payload_fields");
  assert.deepEqual(unknownField.action === "keep" ? unknownField.unknownFields : [], ["naujas_laukas"]);

  const bareText = decideBashOutputReplacement({ toolName: "Bash", command: "pnpm test", toolResponse: "ℹ pass 1" });
  assert.equal(bareText.action === "keep" ? bareText.keepReason : "", "payload_shape_text");

  const wrongTool = decideBashOutputReplacement({ toolName: "Read", command: "pnpm test", toolResponse: "x" });
  assert.equal(wrongTool.action === "keep" ? wrongTool.keepReason : "", "tool_not_replaceable");
});
