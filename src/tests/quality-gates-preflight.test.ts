// VQ-305 (2/3-b): preflight kelio unit testai — policy loaderiai per fake portą (default'ai
// trūkstant failo, fail-fast blogam JSON/nežinomam raktui), architektūros/enforcement vartų
// matrica ir evaluatePreflight seka su fake portais. FS: viskas per fake portą, IŠSKYRUS
// config-drift vartą (016-a-02), kuris tikrina realų `vq/`/`templates/vq/` konfigą.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PolicyConfigError } from "../shared/errors.js";
import {
  codingPrinciplesPolicySchema,
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
import { loadTokenBudgetConfig } from "../application/token-governance/token-budget-config.js";
import { DEFAULT_TURN_LIMITS, resolveMaxTurns } from "../application/token-governance/turn-budget.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import {
  detectHallucinatedAllowedPaths,
  evaluateArchitectureAndPolicyGates,
  splitLeadingFrontmatter,
  stripVerificationPreamble,
  verificationPreamble,
} from "../application/quality-gates/preflight-rules.js";
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
import { evaluateEtalonasRuleViolations } from "../application/quality-gates/preflight-fastpath.js";
import fs from "node:fs/promises";
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

// 016: lubos NEGALI kirsti 0033 kalibracijos — `min(180,120)=120` tyliai anuliavo `large=180`.
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
// 016-a-02: CONFIG DRIFT VARTAS — realų dispatch langą lemia DISKE gulintis konfigas
// (`min(turnLimits.large, dispatchMaxTurns)`); tylus `120` prieš `large: 180` anuliuoja kalibraciją.
const DRIFT_REASON =
  "dispatchMaxTurns žemiau turnLimits.large tyliai nukerta 0033 kalibruotą large langą " +
  "(HUMAN-REVIEW-APPROVED 2026-08-08): resolveMaxTurns skaičiuoja min(lentelė, lubos), tad " +
  "žemesnės lubos anuliuoja kalibraciją be jokio signalo — nukirsta sesija sudegina visą " +
  "kontekstą ir vis tiek virsta repair/human-review ratu. Taisymas: KELK dispatchMaxTurns " +
  "(arba 0 = be ribos), o NE mažink turnLimits.large.";
/** `0` yra dokumentuotas „be ribos" opt-out: jis kalibracijos nekerta, tad varto neliečia. */
function ceilingCoversLarge(ceiling: number, large: number): boolean {
  return ceiling === 0 || ceiling >= large;
}
function assertCeilingCoversLarge(source: string, ceiling: number, large: number): void {
  assert.ok(
    ceilingCoversLarge(ceiling, large),
    `${source}: dispatchMaxTurns=${ceiling} < turnLimits.large=${large}. ${DRIFT_REASON}`,
  );
}

test("preflight-limits: kodo default'ų lubos nekerta kalibruotos turnLimits.large", () => {
  assertCeilingCoversLarge(
    "DEFAULT_PREFLIGHT_LIMITS",
    DEFAULT_PREFLIGHT_LIMITS.dispatchMaxTurns,
    DEFAULT_TURN_LIMITS.large,
  );
});
// `vq/` runtime katalogo git'e gali nebūti (default'ai — ne flaky); `templates/vq/` git'e YRA.
const RUNTIME_ROOTS_WITH_PREFLIGHT_LIMITS = [
  path.join(process.cwd(), "vq"),
  path.join(process.cwd(), "templates", "vq"),
];

test("preflight-limits: realūs konfigai diske nekerta kalibruotos turnLimits.large", async () => {
  for (const runtimeRoot of RUNTIME_ROOTS_WITH_PREFLIGHT_LIMITS) {
    const limits = await loadPreflightLimits(nodeFsAdapter, runtimeRoot);
    const large = limits.turnLimits?.large;
    assert.equal(typeof large, "number", `${runtimeRoot}: loadPreflightLimits privalo užpildyti turnLimits`);
    assertCeilingCoversLarge(`${runtimeRoot} (preflight-limits legacy sluoksnis)`, limits.dispatchMaxTurns, large ?? DEFAULT_TURN_LIMITS.large);

    // KANONINĖ lentelė gyvena `config/token-budget.json` (legacy `turnLimits` realiuose
    // konfiguose nėra) — dispatch kelias taiko lubas BŪTENT jai, tad vartas tikrina ją.
    const limitsFile = await readPreflightLimitsFile(nodeFsAdapter, runtimeRoot);
    const tokenBudget = await loadTokenBudgetConfig(nodeFsAdapter, runtimeRoot, {
      ...(limitsFile.values.turnLimits === undefined ? {} : { legacyTurnLimits: limitsFile.values.turnLimits }),
    });
    const canonicalLarge = tokenBudget.turnLimits.large;
    assertCeilingCoversLarge(`${runtimeRoot} (token-budget kanoninė lentelė)`, limits.dispatchMaxTurns, canonicalLarge);

    // Elgesio kalba: efektyvus large langas = pilna kalibruota reikšmė (arba 0 = be lubų).
    const effective = resolveMaxTurns({
      phase: "implementation",
      tier: "large",
      limits: tokenBudget.turnLimits,
      ceiling: limits.dispatchMaxTurns,
    });
    assert.ok(
      effective === 0 || effective === canonicalLarge,
      `${runtimeRoot}: resolveMaxTurns(large)=${effective}, laukta ${canonicalLarge}. ${DRIFT_REASON}`,
    );
  }
});

// Vartas be įrodymo, kad KANDA, yra dekoracija: `dispatchMaxTurns: 120` privalo jį sulaužyti.
test("preflight-limits: config-drift vartas kanda — 120 lubos prieš large=180 yra pažeidimas", async () => {
  const driftedRoot = "/repo/vq";
  const withCeiling = async (ceiling: number): Promise<{ ceiling: number; large: number }> => {
    const limits = await loadPreflightLimits(
      fakeFs({ [`${driftedRoot}/config/preflight-limits.json`]: JSON.stringify({ dispatchMaxTurns: ceiling }) }),
      driftedRoot,
    );
    return { ceiling: limits.dispatchMaxTurns, large: limits.turnLimits?.large ?? DEFAULT_TURN_LIMITS.large };
  };

  const drifted = await withCeiling(120);
  assert.equal(drifted.large, DEFAULT_TURN_LIMITS.large, "trūkstamas turnLimits užpildomas iš kalibruotos lentelės");
  assert.equal(ceilingCoversLarge(drifted.ceiling, drifted.large), false, "120 lubos nukerta large=180 — vartas krenta");
  const optedOut = await withCeiling(0);
  assert.equal(ceilingCoversLarge(optedOut.ceiling, optedOut.large), true, "0 = be ribos: kalibracija nenukertama");
  // Simetriškas atvejis: lubos NEPAKEISTOS, bet pakelta kanoninė `token-budget.json` lentelė.
  // Be šio įrodymo vartas tikrintų tik legacy sluoksnį ir pakeltą lentelę praleistų tyliai.
  const raisedTable = fakeFs({
    [`${driftedRoot}/config/preflight-limits.json`]: JSON.stringify({ dispatchMaxTurns: 180 }),
    [`${driftedRoot}/config/token-budget.json`]: JSON.stringify({
      version: 1,
      turnLimits: { small: 20, medium: 60, large: 240, repair: 30, semanticReview: 12 },
    }),
  });
  const raisedCeiling = (await loadPreflightLimits(raisedTable, driftedRoot)).dispatchMaxTurns;
  const raised = await loadTokenBudgetConfig(raisedTable, driftedRoot);
  assert.equal(raised.sources.large, "config", "kanoninė large reikšmė ateina iš token-budget.json");
  assert.equal(raised.turnLimits.large, 240);
  assert.equal(
    ceilingCoversLarge(raisedCeiling, raised.turnLimits.large),
    false,
    "180 lubos nukerta pakeltą kanoninį large=240 — vartas krenta",
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
    // Visi katalogo principai numatytu `advisory` lygiu — sąrašas seka katalogą, ne testą.
    codingPrinciplesPolicy: codingPrinciplesPolicySchema.parse({ version: "1.0" }),
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

test("detectHallucinatedAllowedPaths: neegzistuojantis tėvinis katalogas → sugalvotas kelias", () => {
  const task = `# Task

## Failai
Leidžiama:
- \`src/real/existing.ts\`
- \`src/real/new-file.ts\`
- \`src/nera-tokio-katalogo/phantom.ts\`
- \`src/**\`
- \`src/nera-tokio-katalogo/**\`
- \`Dockerfile\`
`;
  const existingDirs = new Set(["src/real"]);
  const dirExists = (dir: string): boolean => existingDirs.has(dir);

  assert.deepEqual(detectHallucinatedAllowedPaths(task, dirExists), ["src/nera-tokio-katalogo/phantom.ts"]);
});

test("detectHallucinatedAllowedPaths: fail-open be `## Failai` sekcijos ir kai visi katalogai egzistuoja", () => {
  assert.deepEqual(
    detectHallucinatedAllowedPaths("# Task\n\n## Tikslas\nBe Failai sekcijos.\n", () => false),
    [],
  );
  assert.deepEqual(detectHallucinatedAllowedPaths(CANONICAL_TASK, () => true), []);
});

const VERIFICATION_COMMANDS = { rebuild: "pnpm build", checks: ["pnpm typecheck", "pnpm test"] };

test("stripVerificationPreamble: vedantis Žingsnis 0 + Sandbox taisyklės blokas nuimamas", () => {
  const preamble = verificationPreamble(VERIFICATION_COMMANDS);
  const withPreamble = `${preamble}${CANONICAL_TASK}`;
  assert.notEqual(withPreamble, CANONICAL_TASK, "sanity: preamble realiai pridėta");
  assert.equal(stripVerificationPreamble(withPreamble), CANONICAL_TASK);
});

test("stripVerificationPreamble: ne-vedantis pasikartojimas (po `# Task`) NEnuimamas", () => {
  const taskWithLateHeading = "# Task\n\n## Sandbox taisyklės (paminėta viduryje, ne pradžioje)\nNe preambulė — po `# Task`.\n\n## Tikslas\nX.\n";
  assert.equal(stripVerificationPreamble(taskWithLateHeading), taskWithLateHeading);
});

test("stripVerificationPreamble: fence bloke cituojama antraštė lieka nepaliesta (nelaikoma preambule)", () => {
  const fencedExample = `\`\`\`text
## Sandbox taisyklės (privaloma — taupo turns)
Tai tik pavyzdys šablono dokumentacijoje, ne tikra vedanti antraštė.
\`\`\`

${CANONICAL_TASK}`;
  assert.equal(stripVerificationPreamble(fencedExample), fencedExample);
});

test("stripVerificationPreamble: tekstas be preambulės grįžta nepakitęs", () => {
  assert.equal(stripVerificationPreamble(CANONICAL_TASK), CANONICAL_TASK);
  assert.equal(stripVerificationPreamble(""), "");
});

// Task 149: queue failas prasideda YAML frontmatter'iu — preambulė negali jo nuryti grįžtant iš
// active/delegated lango atgal į queue. `---` vėliau tekste (po `# Task`) NĖRA frontmatter'is.
const FRONTMATTER = "---\nschema_version: 2\nid: demo\nscope:\n  allow:\n    - src/x.ts\n---\n";

test("splitLeadingFrontmatter/stripVerificationPreamble: frontmatter+preambulė simetrija", () => {
  const split = splitLeadingFrontmatter(`${FRONTMATTER}${CANONICAL_TASK}`);
  assert.equal(split.frontmatter, FRONTMATTER);
  assert.equal(`${split.frontmatter}${split.body}`, `${FRONTMATTER}${CANONICAL_TASK}`);
  assert.deepEqual(splitLeadingFrontmatter(CANONICAL_TASK), { frontmatter: "", body: CANONICAL_TASK });
  const laterDash = "# Task\n\n---\n\n## Tikslas\nX.\n";
  assert.deepEqual(splitLeadingFrontmatter(laterDash), { frontmatter: "", body: laterDash });

  const preamble = verificationPreamble(VERIFICATION_COMMANDS);
  assert.equal(stripVerificationPreamble(`${FRONTMATTER}${preamble}${CANONICAL_TASK}`), `${FRONTMATTER}${CANONICAL_TASK}`);
});

// 156-a-02: evaluateEtalonasRuleViolations yra PLONAS adapteris virš domain
// validateTaskAgainstEtalonas — čia tikrinama TIK projekcija (rule id/citata perduodami nepakitę)
// ir korpusas; pačias taisykles dengia domain-tasks-etalonas-rules.test.ts.
const etalonasTask = (failai: string): string =>
  `# Task\n\n## Spec source\nAG/openspec/changes/demo\n\n## Tikslas\nX.\n\n## Agentai\ncoder\n\n## Failai\nLeidžiama:\n${failai}\n\n## Veiksmas\n- daryk\n\n## Patikra\n- \`pnpm test\`\n\n## Stop\nStop.\n\n## Neįtraukta\n- Kita.\n`;
test("156-a-02: adapteris perduoda domain rule id ir citatą nepakitusius; VISI queue/*.md švarūs", async () => {
  // Struktūrinė domain taisyklė citatos neturi — adapteris ją pakeičia `message`, ne `undefined`:
  // preflight-validate.ts citatas jungia į reason'ą, ir „undefined" ten būtų matomas tekste.
  const structural = evaluateEtalonasRuleViolations("# Task\n\n## Tikslas\nX.\n").find((v) => v.ruleId === "mandatory-section-missing");
  assert.ok(structural, "domain rule id privalo pasiekti išvestį nepervadintas");
  assert.match(structural.citation, /000-etalonas\.md/);
  assert.equal(structural.detail, structural.citation, "be domain detail abu laukai krenta į message");
  const noTest = evaluateEtalonasRuleViolations(etalonasTask("- `src/x.ts`")).find((v) => v.ruleId === "production-file-without-test");
  assert.ok(noTest, "domain taisyklė su citata privalo pasiekti išvestį");
  assert.match(noTest.citation, /000-etalonas\.md ## Failai \(2\)/, "citata imama iš domain, ne perrašoma");
  const wildcard = evaluateEtalonasRuleViolations(etalonasTask("- `src/tests/**`")).find((v) => v.ruleId === "failai-wildcard-without-justification");
  assert.match(wildcard?.citation ?? "", /Katalogo wildcard'as/);
  assert.deepEqual(evaluateEtalonasRuleViolations(etalonasTask("- `src/x.ts`\n- `src/tests/x.test.ts`")), []);
  const queueDir = "AG/tasks/queue";
  // Tuščia eilė — teisėta sėkmės būsena (2026-08-30); klaidingą kelią tebegaudo readdir ENOENT.
  for (const name of (await fs.readdir(queueDir)).filter((n) => n.endsWith(".md"))) {
    assert.deepEqual(evaluateEtalonasRuleViolations(await fs.readFile(`${queueDir}/${name}`, "utf8")), [], name);
  }
});
