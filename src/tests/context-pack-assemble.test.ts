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
import {
  applyCodeContextTiers,
  measureHypotheticalSourceChars,
  measureSymbolTierChars,
} from "../application/context-pack/assemble/tiers.js";
import type { CodeContextCandidates, TieredContextSymbol } from "../application/context-pack/assemble/gather.js";
import type { SourceSlice } from "../application/context-pack/source-slice.js";
import { contextPackSchema } from "../application/context-pack/context-pack-schema.js";
import { createContextCacheAdapter } from "../infrastructure/persistence/context-cache-store.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { parseExecutionContextMetadata, contextArtifactSha256 } from "../application/context-pack/execution-context-fingerprint.js";
import { computeContextCacheKey } from "../application/context-pack/context-cache-key.js";
import { loadContextBudget, DEFAULT_CONTEXT_BUDGET } from "../application/policy-governance/context-budget.js";
import { loadContextSelectionPolicy, DEFAULT_CONTEXT_SELECTION_LIMITS } from "../application/policy-governance/context-selection-policy.js";
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
    assert.equal(result.pack.discovered_docs, undefined, "be kontrolinių dokumentų lauko pack'e NĖRA (task 101-c)");

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

// `allowed_paths` renderyje deklaruojami kaip „no file outside this list may be created,
// changed or deleted". Anksčiau jie buvo karpomi iki `max_files` (numatytai 8), tad devintas
// leistinas failas worker'iui atrodydavo UŽDRAUSTAS — deklaracija virsdavo melu. `max_files`
// šioje sistemoje yra preflight peržiūros slenkstis, ne karpymo limitas.
test("assembleContextPack: allowed_paths yra pilni, net kai jų daugiau nei max_files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-302-paths-"));
  try {
    const files = Array.from({ length: DEFAULT_CONTEXT_BUDGET.max_files + 3 }, (_, index) => `src/f${index}.ts`);
    const task = [
      "# Task",
      "",
      "## Tikslas",
      "Plati, bet patvirtinta apimtis.",
      "",
      "## Failai",
      "Leidžiama:",
      ...files.map((file) => `- \`${file}\``),
      "",
      "## Patikra",
      "- `pnpm test`",
      "",
    ].join("\n");

    await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
    await writeFile(path.join(root, "AG", "tasks", "queue", "0043-placi.md"), task, "utf8");

    const result = await assembleContextPack(["AG/tasks/queue/0043-placi.md"], root, {
      fs: nodeContextPackFsPort,
      codeFs: nodeFsTestPort,
    });

    assert.equal(files.length > DEFAULT_CONTEXT_BUDGET.max_files, true, "fikstūra tikrai viršija limitą");
    assert.deepEqual(result.pack.allowed_paths, files, "riba atkeliauja PILNA, be karpymo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// `dropped_item_count` skaičiuoja TIK graph-selection budgeter'io praradimus. Retrieval stadijos
// praradimai (neišspręsti ref'ai, fragmentų limitas, dublikatai, simbolių biudžetas) į jokią
// metriką nepatekdavo — matomi buvo tik `spec_fragment_warnings` eilutėse, kurios turi lubas ir
// yra skirtos žmogui. `spec_dropped_count` tai uždaro, atskirai nuo budgeter'io, kad išliktų
// priskyrimas: sulietas skaičius atimtų vienintelį dalyką, dėl kurio metrika naudinga.
test("assembleContextPack: spec_dropped_count fiksuoja retrieval stadijos praradimus", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-302-dropped-"));
  try {
    const task = [
      "# Task",
      "",
      "## Spec source",
      "doc/nera-1.md",
      "doc/nera-2.md",
      "",
      "## Tikslas",
      "Tikslas su neišsprendžiamais spec ref'ais.",
      "",
      "## Failai",
      "Leidžiama:",
      "- `src/a.ts`",
      "",
      "## Patikra",
      "- `pnpm test`",
      "",
    ].join("\n");

    await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
    await writeFile(path.join(root, "AG", "tasks", "queue", "0044-drop.md"), task, "utf8");

    const result = await assembleContextPack(["AG/tasks/queue/0044-drop.md"], root, {
      fs: nodeContextPackFsPort,
      codeFs: nodeFsTestPort,
    });

    const metricsRaw = await readFile(path.join(root, "vq", "logs", "context-size.jsonl"), "utf8");
    const record = JSON.parse(metricsRaw.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

    assert.equal(record["spec_dropped_count"], 2, "abu neišspręsti ref'ai suskaičiuoti");
    assert.equal(record["dropped_item_count"], 0, "budgeter'io skaičius NESULIETAS su retrieval'u");
    assert.equal(record["code_context_dropped_count"], 0, "trečia stadija taip pat atskira");
    assert.equal(result.pack.spec_fragments.length, 0);
    assert.equal(
      result.pack.spec_fragment_warnings.filter((warning) => warning.startsWith("spec source not found")).length,
      2,
      "žmogui skirtas kanalas irgi lieka",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Paskutinis `context-size.jsonl` įrašas — surinkimo kešo verdiktas. */
async function lastCacheStatus(root: string): Promise<unknown> {
  const raw = await readFile(path.join(root, "vq", "logs", "context-size.jsonl"), "utf8");
  return (JSON.parse(raw.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>)["cache_status"];
}

// Task 101-c: `candidateSet.docsSnippets` lizdas nebe tuščias. Testas laiko VISUS tris to
// prijungimo pjūvius vienoje vietoje, nes atskirai kiekvienas jų praeitų ir su spraga:
// kandidatas pack'e, jo tekstas `execution-context.md` UŽ pasitikėjimo aptvaro, ir dokumento
// TURINYS cache rakte. Be trečiojo hit'as grąžintų pasenusį tekstą — tyliai anuliuotų patį
// prijungimą, o pack'as apie tai nieko nesakytų.
//
// Dokumentas — `docs/notes.md`: `.md` nėra indeksuojamų plėtinių sąraše, jis nėra nei taikinys,
// nei `## Spec source`, tad jo pakeitimas gali paveikti raktą TIK per naujuosius šaltinius.
test("assembleContextPack: discovered docs patenka į pack'ą, renderį ir cache tapatybę", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-101c-docs-"));
  try {
    const task = [
      "# Task", "",
      "## Tikslas", "Prijungti discovered dokumentų atranką prie context pack surinkimo.", "",
      "## Failai", "Leidžiama:", "- `src/a.ts`", "",
      "## Veiksmas", "- Atranka ima kontrolinius dokumentus.", "",
      "## Patikra", "- `pnpm test`", "",
    ].join("\n");
    await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "AG", "tasks", "queue", "0101-docs.md"), task, "utf8");
    const doc = "# Kontroliniai dokumentai\n\nContext pack atranka ima discovered dokumentų gabalus.\n";
    await writeFile(path.join(root, "docs", "notes.md"), doc, "utf8");

    const deps = {
      fs: nodeContextPackFsPort,
      codeFs: nodeFsTestPort,
      cache: createContextCacheAdapter(root, path.join(root, "vq")),
    };
    const first = await assembleContextPack(["AG/tasks/queue/0101-docs.md"], root, deps);
    const discovered = first.pack.discovered_docs ?? [];
    assert.ok(discovered.length > 0, "kontrolinis dokumentas privalo tapti kandidatu");
    assert.ok(discovered.every((entry) => entry.startsWith("docs/notes.md")), `ref rodo į dokumentą: ${discovered[0]}`);
    assert.deepEqual(first.pack.discovered_docs_truncated, [], "netilpusio kirpimo šioje apimtyje nėra");

    const rendered = await readFile(first.executionContextPath, "utf8");
    assert.match(rendered, /## Discovered doc: docs\/notes\.md/, "blokas pasiekia worker'io dokumentą");
    assert.match(rendered, /type="discovered-doc"/, "svetimas tekstas guli UŽ aptvaro, ne plikas");

    await assembleContextPack(["AG/tasks/queue/0101-docs.md"], root, deps);
    assert.equal(await lastCacheStatus(root), "hit", "kontrolė: nepakitęs medis privalo duoti hit'ą");

    await writeFile(path.join(root, "docs", "notes.md"), `${doc}\nAtranka gabalus dar ir rikiuoja.\n`, "utf8");
    const third = await assembleContextPack(["AG/tasks/queue/0101-docs.md"], root, deps);
    assert.equal(await lastCacheStatus(root), "miss", "pakeistas dokumentas privalo anuliuoti įrašą");
    assert.notDeepEqual(third.pack.discovered_docs, discovered, "ir pack'as neša jau naują tekstą");
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

// Task 089: SIG pakopą gavęs simbolis pack'e nebeneša savo source pjūvio, tad iš pack'o
// nebeišvesi, KIEK jis būtų kainavęs SRC pakopoje. Skaičius matuojamas surinkimo metu, kol
// pjūvio tekstas dar rankose — be jokio papildomo source skaitymo.
const tierCandidate = (id: string, signature: string): TieredContextSymbol => ({
  id,
  file: "src/a.ts",
  name: id,
  line: 1,
  endLine: 4,
  signature,
  exported: true,
  reason: "exported",
  role: "target",
});

const tierSlice = (id: string, text: string): [string, SourceSlice] => [
  id,
  { file: "src/a.ts", line: 1, endLine: 4, text, hash: "a".repeat(64) },
];

const tierCandidates = (sliceText: string, signature: string, withSlices: boolean): CodeContextCandidates => ({
  enabled: true,
  architectureNodes: [],
  codeGraphNeighbors: [],
  impactedTests: [],
  summary: [],
  notes: [],
  symbolFragments: [tierCandidate("a#x", signature), tierCandidate("a#y", signature)],
  ...(withSlices ? { sourceSlices: new Map([tierSlice("a#x", sliceText), tierSlice("a#y", sliceText)]) } : {}),
  rebuilt: false,
});

test("symbol tiers: hipotetinis SRC matuojamas SIG režimu, o SRC ir slices-off duoda nulį", () => {
  const sliceText = "x".repeat(120);
  const signature = "s".repeat(20);

  // SIG režimas: pjūvis viršija per-simbolio lubas, tad abu simboliai nukrenta į SIG ir
  // pack'e lieka be `source`.
  const sigCandidates = tierCandidates(sliceText, signature, true);
  const sig = applyCodeContextTiers(sigCandidates, { ...DEFAULT_CONTEXT_SELECTION_LIMITS, max_symbol_slice_chars: 40 }, 0);
  assert.deepEqual(
    sig.symbols.map((symbol) => symbol.tier),
    ["SIG", "SIG"],
  );
  assert.ok(
    sig.symbols.every((symbol) => symbol.source === undefined),
    "SIG simbolis pjūvio nebeneša — būtent todėl skaičiaus iš pack'o nebeišvesi",
  );

  const hypothetical = measureHypotheticalSourceChars(sig.symbols, sigCandidates.sourceSlices);
  assert.equal(hypothetical, 2 * sliceText.length);
  assert.equal(measureSymbolTierChars(sig.symbols).symbolSourceChars, 0, "pack'o pusėje SRC vis dar nulis");
  assert.ok(
    hypothetical >= measureSymbolTierChars(sig.symbols).symbolSignatureChars,
    "hipotetinis SRC negali būti mažesnis už tų pačių simbolių SIG svorį",
  );

  // SRC režimas: pjūvis telpa, simboliai jį neša, ir tikrasis svoris matuojamas iš paties
  // pack'o — dubliuoti jį hipotetiniame lauke reikštų skaičiuoti tuos pačius simbolius du kartus.
  const srcCandidates = tierCandidates(sliceText, signature, true);
  const src = applyCodeContextTiers(srcCandidates, DEFAULT_CONTEXT_SELECTION_LIMITS, 0);
  assert.deepEqual(
    src.symbols.map((symbol) => symbol.tier),
    ["SRC", "SRC"],
  );
  assert.equal(measureHypotheticalSourceChars(src.symbols, srcCandidates.sourceSlices), 0);
  assert.equal(measureSymbolTierChars(src.symbols).symbolSourceChars, 2 * sliceText.length);

  // `symbol_slices` išjungtas: pjūvių niekas neskaitė, tad matuoti nėra ko — ir laukas neatsiranda.
  const off = tierCandidates(sliceText, signature, false);
  assert.equal(measureHypotheticalSourceChars(off.symbolFragments, off.sourceSlices), 0);

  // Pack'o projekcija: laukas pereina schemą kaip yra, o jo NEturintis pack'as lieka be jo —
  // ne su nuliu. Nulinis default'as būtų tylus melas „SRC pusėje nieko neprarasta".
  const withField = contextPackSchema.parse({
    task_id: "089-tiers",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    code_context: { enabled: true, symbol_fragments: [], symbol_hypothetical_src_chars: hypothetical },
  });
  assert.equal(withField.code_context?.symbol_hypothetical_src_chars, hypothetical);
  const without = contextPackSchema.parse({
    task_id: "089-tiers",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    code_context: { enabled: true, symbol_fragments: [] },
  });
  assert.equal(without.code_context?.symbol_hypothetical_src_chars, undefined);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(without.code_context ?? {}, "symbol_hypothetical_src_chars"),
    "senas pack'as lauko neįgyja net kaip undefined — projekcija nepakitusi",
  );
});
