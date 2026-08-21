// Context-pack assembly use-case: parses a dispatch task file, retrieves spec fragments
// and (optionally) code-graph impact context, assembles a schema-validated ContextPack,
// and persists it. Behaviour etalon: AG_loop application/context-pack/assemble.ts
// (orkestracijos pusė; WBR VQ-302 skaidymas į parse-task/gather/tiers/persist + šis
// failas). IO — per portus; CLI argumentų parsinimas/išvedimas — E5.

import path from "node:path";
import { withPolicyConfigErrors } from "../../../shared/errors.js";
import { parseWithSchema } from "../../../shared/schema.js";
import { toPosixPath } from "../../../shared/paths.js";
import { resolveDispatchTaskFile, taskFileStem } from "../../../domain/tasks/index.js";
import { isContextCompressionFeatureEnabledForTask } from "../../../domain/policies/compression/canary.js";
import type { CodeIntelligenceFileSystemPort } from "../../code-intelligence/ports.js";
import { checkCodeIndexFreshness, codeIndexPath } from "../../code-intelligence/store/code-index-store.js";
import type { RetrievedFragment } from "../../code-intelligence/retrieval/spec-fragments.js";
import { loadContextBudget } from "../../policy-governance/context-budget.js";
import { loadContextPackToolFlags } from "../../policy-governance/tool-budget-config.js";
import { loadAgentPolicy } from "../../policy-governance/agent-policy.js";
import {
  effectiveContextSelectionLimits,
  loadContextSelectionPolicy,
  planCodeContextReductions,
  selectGraphFirstContext,
  type GraphFirstContextCandidates,
  type GraphFirstSelection,
} from "../../policy-governance/context-selection-policy.js";
import { optimizeTokenBudget } from "../../token-governance/token-budget-optimizer.js";
import { classifyTask } from "../../../domain/policies/task-classification.js";
import { defaultTaskClassificationPolicy } from "../../../domain/policies/task-classification-defaults.js";
import { effectiveAgentRole, parseAgentBlock, resolveAgentModelHint } from "../../../domain/policies/agent-selection.js";
import { measureTaskSize } from "../../../domain/tasks/size.js";
import { contextPackSchema, type ContextPack } from "../context-pack-schema.js";
import { loadEffectiveCompressionPolicy } from "../effective-compression-policy.js";
import { contextCompressionCacheSources } from "../compression-cache-sources.js";
import { computeContextCacheKey } from "../context-cache-key.js";
import { CODE_INDEX_STALE, CODE_INDEX_UNUSED } from "../context-cache-model.js";
import { estimateTokensFromChars } from "../metrics.js";
import { COMPRESSION_FALLBACK_SIZE, compileWorkerPromptTaskForDispatch } from "../worker-prompt-compilation.js";
import { systemClock, type ContextCachePort, type ContextPackFileSystemPort } from "../ports.js";
import { explicitAllowedPaths, parseTaskMarkdown } from "./parse-task.js";
import { runSpecPhase } from "./spec-phase.js";
import {
  autoGatherCodeContextCandidates,
  gatherCodeContextCandidates,
  type CodeContext,
  type CodeContextGatherOptions,
} from "./gather.js";
import { applyCodeContextReduction, applyCodeContextTiers, codeContextSymbolState } from "./tiers.js";
import { persistContextPack, type ContextPackArtifactSink, type ContextPackResult } from "./persist.js";
import type { AttemptIdentityPort } from "../metrics.js";

export type { ContextPackArtifactSink, ContextPackResult } from "./persist.js";

export type AssembleContextPackDeps = {
  fs: ContextPackFileSystemPort;
  codeFs: CodeIntelligenceFileSystemPort;
  /** Nesant porto cache elgsena = `--no-context-cache` (bypass). */
  cache?: ContextCachePort;
  attemptIdentity?: AttemptIdentityPort;
  artifacts?: ContextPackArtifactSink;
};

// A selection with every droppable context source empty — matuoja fiksuotą, nedroppinamą
// overhead'ą, kuris rezervuojamas iš bendro biudžeto prieš varžantis droppinamiems šaltiniams.
const EMPTY_SELECTION: GraphFirstSelection = {
  spec_refs: [],
  architecture_nodes: [],
  allowed_paths: [],
  related_files: [],
  impacted_tests: [],
  docs_snippets: [],
  order: [],
  dropped: [],
  estimated_chars: 0,
};

export async function assembleContextPack(
  args: string[],
  projectRoot: string,
  deps: AssembleContextPackDeps,
): Promise<ContextPackResult> {
  const taskArg = args.find((arg) => !arg.startsWith("--"))?.trim();
  const withCodeGraph = args.includes("--with-code-graph");
  if (!taskArg) {
    throw new Error("Usage: context-pack <task-file> [--with-code-graph]");
  }

  const root = path.resolve(projectRoot);
  const taskPath = resolveDispatchTaskFile(root, taskArg);
  const taskText = (await deps.fs.readTextFileIfExists(taskPath)) ?? "";
  if (!taskText) {
    throw new Error(`task file is missing or empty: ${taskPath}`);
  }
  const parsedTask = parseTaskMarkdown(taskText, taskPath);
  const runtimeRoot = path.join(root, "vq");
  const configFile = (name: string): string => toPosixPath(path.relative(root, path.join(runtimeRoot, "config", name)));
  // Every POLICY-config load below is marked as environment scope (task 0032): a malformed
  // config breaks every queued task, so the caller aborts the loop as infrastructure
  // instead of parking one innocent task in human-review. Deliberately an allowlist of
  // loader calls: render-execution-context validates TASK data and stays outside it.
  const baseBudget = await withPolicyConfigErrors(configFile("context-budget.json"), () =>
    loadContextBudget(deps.fs, runtimeRoot),
  );
  const budget = optimizeTokenBudget({
    metrics: measureTaskSize(taskText),
    // Klasifikacijos konfigo loader'is — VQ-305; iki jo galioja etalono defaults rinkinys
    // (domain/policies/task-classification-defaults, tas pats turinys kaip AG_loop default).
    classification: classifyTask(taskText, parsedTask.allowedPaths, defaultTaskClassificationPolicy),
    baseBudget,
  });
  const toolFlags = await withPolicyConfigErrors(configFile("tool-budget.json"), () =>
    loadContextPackToolFlags(deps.fs, runtimeRoot),
  );
  const agentPolicy = await withPolicyConfigErrors(configFile("agents.json"), () =>
    loadAgentPolicy(deps.fs, runtimeRoot),
  );
  const agentSelection = parseAgentBlock(taskText);
  const agent = {
    role: effectiveAgentRole(agentSelection, agentPolicy),
    supporting: agentSelection.supporting,
    model_hint: resolveAgentModelHint(agentSelection, agentPolicy),
  };
  const agents = [
    ...new Set(
      [agentSelection.primary, ...agentSelection.supporting]
        .filter((r): r is string => Boolean(r))
        .map((r) => r.toLowerCase()),
    ),
  ];
  const targets = explicitAllowedPaths(parsedTask.allowedPaths);

  // Deterministic context cache (task 1108, spec RAG-2). Cohort membership is a property of
  // the TASK (task 0031), so the whole effective policy — arrest applied, cohort resolved
  // off it — is loaded once here and travels to the single telemetry writer.
  const taskId = taskFileStem(taskPath);
  const { config: compression, arrestView, canaryFeatures = [] } = await withPolicyConfigErrors(
    configFile("context-compression.json"),
    () => loadEffectiveCompressionPolicy({ fs: deps.fs, clock: systemClock, runtimeRoot, taskId }),
  );
  const symbolSlicesEnabled = isContextCompressionFeatureEnabledForTask(compression, "symbol_slices", taskId);
  // Size guard prediction (task 0007/0032): TA PATI gryna kompiliacija, kurią vykdo
  // dispatch, nusprendžia, ar šio task'o kompiliuotas kūnas būtų atmestas dėl dydžio.
  // Skaičiuojama VIENĄ kartą, kad abu persist kvietimai kohortą žymėtų identiškai.
  const dispatchCompilation = compileWorkerPromptTaskForDispatch({ config: compression, taskId, taskText });
  const canarySizeFallback =
    dispatchCompilation.kind === "fallback" && dispatchCompilation.fallback === COMPRESSION_FALLBACK_SIZE;

  const cacheEnabled = !args.includes("--no-context-cache") && deps.cache !== undefined;
  const cache = deps.cache;
  let cacheKey: ReturnType<typeof computeContextCacheKey> | undefined;
  if (cache) {
    const cacheSources = await cache.collectSources({
      taskPath,
      taskText,
      targets,
      specSources: parsedTask.specSources,
    });
    // The pack's content also depends on the compression feature flags (task 0023) AND on
    // the arrest that narrows them (task 0038) — both must invalidate cached packs.
    cacheSources.push(
      ...(await contextCompressionCacheSources({ fs: deps.fs, root, runtimeRoot, arrestView })),
    );
    cacheKey = computeContextCacheKey(cacheSources);
    if (cacheEnabled) {
      const lookup = await cache.lookup(cacheKey, () => currentCodeIndexDescriptor(deps.codeFs, root));
      if (lookup.status === "hit") {
        // The cached artifact is the encoded pack itself, so an unchanged repository writes
        // byte-identical context-pack.json and execution-context.md without re-retrieving
        // spec fragments or re-traversing the code index.
        return await persistContextPack({
          fs: deps.fs,
          runtimeRoot,
          taskText,
          encoded: lookup.entry.context_pack_json,
          maxContextChars: budget.max_context_chars,
          cacheStatus: "hit",
          droppedItemCount: lookup.entry.dropped_item_count,
          specDroppedCount: lookup.entry.spec_dropped_count,
          codeContextDroppedCount: lookup.entry.code_context_dropped_count,
          codeContextRebuilt: false,
          canaryFeatures,
          canarySizeFallback,
          ...(deps.attemptIdentity === undefined ? {} : { attemptIdentity: deps.attemptIdentity }),
          ...(deps.artifacts === undefined ? {} : { artifacts: deps.artifacts }),
        });
      }
    }
  }

  // Visa spec fragmentų fazė (paėmimas → reitingavimas → biudžetas → pranešimai) — `spec-phase`.
  const specPhase = await runSpecPhase({
    codeFs: deps.codeFs,
    projectRoot: root,
    parsedTask,
    specCharBudget: Math.max(0, budget.max_context_chars - taskText.length),
    maxSpecFragments: budget.max_spec_fragments,
  });

  // The policy file may carry its own `max_context_chars` ceiling, while the pack below is
  // measured and enforced against the PER-TASK budget the optimizer produced (task 0006).
  const selectionLimits = effectiveContextSelectionLimits(
    await withPolicyConfigErrors(configFile("context-selection-policy.json"), () =>
      loadContextSelectionPolicy(deps.fs, runtimeRoot, {
        max_spec_fragments: budget.max_spec_fragments,
        max_context_chars: budget.max_context_chars,
      }),
    ),
    budget.max_context_chars,
  );
  // With `symbol_slices` off both options are inert, so the gathered candidates — and the
  // pack built from them — stay byte-identical to the pre-0023 behaviour.
  const codeContextOptions: CodeContextGatherOptions = {
    maxContractSymbols: symbolSlicesEnabled ? selectionLimits.max_contract_symbols : 0,
    readSourceSlices: symbolSlicesEnabled,
  };
  const codeCandidates = withCodeGraph
    ? await gatherCodeContextCandidates(deps.codeFs, deps.fs, root, targets, selectionLimits, codeContextOptions)
    : await autoGatherCodeContextCandidates(deps.codeFs, deps.fs, root, targets, selectionLimits, codeContextOptions);

  // Single priority-aware budget decision (tasks 921 + 977): one selectGraphFirstContext
  // call trims every droppable context source against one char budget.
  const fragmentKey = (fragment: RetrievedFragment): string => `${fragment.ref}\n${fragment.text}`;

  const fragmentByKey = new Map(specPhase.kept.map((fragment) => [fragmentKey(fragment), fragment]));

  // allowed_paths are the authoritative edit boundary: always rendered in full and never
  // trimmed — accounted for as fixed reserved overhead, not as a droppable candidate here.
  const candidateSet: GraphFirstContextCandidates = {
    specRefs: specPhase.kept.map(fragmentKey),
    architectureNodes: codeCandidates?.architectureNodes ?? [],
    allowedPaths: [],
    codeGraphNeighbors: codeCandidates?.codeGraphNeighbors ?? [],
    impactedTests: codeCandidates?.impactedTests ?? [],
    docsSnippets: [],
  };

  const keptFragmentsOf = (selection: GraphFirstSelection): RetrievedFragment[] =>
    selection.spec_refs
      .map((key) => fragmentByKey.get(key))
      .filter((fragment): fragment is RetrievedFragment => Boolean(fragment));

  const buildCodeContext = (selection: GraphFirstSelection): CodeContext | undefined =>
    codeCandidates === undefined
      ? undefined
      : {
          enabled: codeCandidates.enabled,
          related_files: [...selection.related_files],
          impacted_tests: [...selection.impacted_tests],
          architecture_nodes: [...selection.architecture_nodes],
          priority_order: selection.order,
          summary: codeCandidates.summary,
          symbol_fragments: codeCandidates.symbolFragments,
          notes: [
            ...codeCandidates.notes,
            ...(selection.dropped.length > 0
              ? [`context truncated by policy limits: dropped ${selection.dropped.length} item(s)`]
              : []),
          ],
        };

  const buildPack = (selection: GraphFirstSelection): ContextPack => {
    const codeContext = buildCodeContext(selection);
    const keptFragments = keptFragmentsOf(selection);
    return parseWithSchema(
      contextPackSchema,
      {
        task_id: taskId,
        phase: "implementation",
        goal: parsedTask.goal,
        // NEKARPOMA. `allowed_paths` yra redagavimo RIBA, o renderis ją taip ir deklaruoja:
        // „no file outside this list may be created, changed or deleted". Nukirptas sąrašas
        // paverčia tą teiginį melu — worker'iui devintas leistinas failas atrodo uždraustas.
        //
        // `max_files` šioje sistemoje NĖRA karpymo limitas: preflight jį naudoja kaip
        // ŽMOGAUS PERŽIŪROS slenkstį (`context files N > M` → review). Tad per didelė apimtis
        // sustabdoma anksčiau ir sąmoningai, o jei žmogus ją patvirtino, riba privalo atkeliauti
        // pilna. Netilpus, `renderExecutionContext` meta garsiai — ir tai teisingas gedimas,
        // nes tyliai nukirsta riba yra pavojingesnė už nutrūkusį dispatch'ą.
        allowed_paths: parsedTask.allowedPaths,
        agents,
        spec_fragments: keptFragments.map(fragmentKey),
        spec_fragment_truncated: keptFragments.filter((fragment) => fragment.truncated).map((fragment) => fragment.ref),
        spec_fragment_warnings: specPhase.warnings,
        acceptance_criteria: parsedTask.acceptanceCriteria,
        ...(parsedTask.stopCondition ? { stop_condition: parsedTask.stopCondition } : {}),
        architecture_rules: codeContext?.notes ?? [],
        checks: parsedTask.checks,
        budget: {
          max_context_chars: budget.max_context_chars,
          max_llm_calls: 3,
          browser: toolFlags.browser,
          scraper: toolFlags.scraper,
          mcp: toolFlags.mcp,
        },
        code_context: codeContext,
        out_of_scope: parsedTask.outOfScope,
        agent,
      },
      "context-pack",
    );
  };

  const encode = (pack: ContextPack): string => `${JSON.stringify(pack, null, 2)}\n`;

  // Exact fixed overhead: the encoded pack with every droppable context source empty.
  let reservedChars = encode(buildPack(EMPTY_SELECTION)).length;

  // REF/SIG/SRC tiers (task 0023). The tier decision runs against the overhead measured
  // ABOVE — before any slice text enters the pack; the enriched symbols then become part
  // of the fixed overhead themselves.
  const notesBeforeTiers = codeCandidates ? [...codeCandidates.notes] : [];
  if (symbolSlicesEnabled && codeCandidates && codeCandidates.symbolFragments.length > 0) {
    const tiered = applyCodeContextTiers(codeCandidates, selectionLimits, reservedChars);
    codeCandidates.symbolFragments = tiered.symbols;
    codeCandidates.notes.push(...tiered.notes);
    reservedChars = encode(buildPack(EMPTY_SELECTION)).length;
  }

  const droppableKept = (selection: GraphFirstSelection): number =>
    selection.spec_refs.length +
    selection.architecture_nodes.length +
    selection.related_files.length +
    selection.impacted_tests.length +
    selection.docs_snippets.length;

  // Kopėčių numesti simboliai iki šiol buvo matomi TIK `reduction.note` eilutėje pack'o
  // pastabose — žmogui skirtame tekste, ne metrikoje. Trečias praradimų šaltinis, greta
  // budgeter'io ir retrieval'o, ir jam reikia savo skaičiaus dėl tos pačios priežasties:
  // sulietas skaičius nebeleistų pasakyti, KURI stadija prarado kontekstą.
  let codeContextDroppedCount = 0;

  // The hard limit as a DECISION, not an exception (task 0006): kai rezervas viršija
  // biudžetą, code context'as numetamas deterministiškai — po vieną ladder rungą,
  // permatuojant po kiekvieno ir sustojant ties pirmu tilpusiu.
  if (
    symbolSlicesEnabled &&
    codeCandidates &&
    codeCandidates.symbolFragments.length > 0 &&
    reservedChars > budget.max_context_chars
  ) {
    const fullSymbols = codeCandidates.symbolFragments;
    for (const reduction of planCodeContextReductions(fullSymbols.map(codeContextSymbolState))) {
      // Each rung is re-derived from the untouched symbol list, and its single note REPLACES
      // both the previous rung's note and the per-symbol tier-downgrade notes.
      codeCandidates.symbolFragments = applyCodeContextReduction(fullSymbols, reduction);
      codeCandidates.notes = [...notesBeforeTiers, reduction.note];
      // Skaičiuojami TIK visiškai numesti simboliai. Pakopos nuleidimas (SRC → SIG → REF) NĖRA
      // praradimas: simbolis lieka pack'e, tik su mažiau detalių. Kopėčios rungas yra KUMULIATYVI
      // būsena, tad reikšmė perrašoma, o ne kaupiama.
      codeContextDroppedCount = reduction.dropped.length;
      reservedChars = encode(buildPack(EMPTY_SELECTION)).length;
      if (reservedChars <= budget.max_context_chars) {
        break;
      }
    }
  }

  // The per-item estimate inside selectGraphFirstContext is close but not exact, so
  // re-measure the real encoded pack (877/878 regression). If it still overshoots, force
  // the *same* priority model to drop one more lowest-priority item by shrinking its
  // effective budget just below current usage, then re-measure.
  let selection = selectGraphFirstContext(candidateSet, selectionLimits, reservedChars);
  let pack = buildPack(selection);
  let encoded = encode(pack);
  while (encoded.length > budget.max_context_chars && droppableKept(selection) > 0) {
    // Tightened against the SELECTION ceiling the estimate was produced by, so the next
    // pass gives up exactly one more lowest-priority item.
    const tightenedReserved = selectionLimits.max_context_chars - (selection.estimated_chars - 1);
    selection = selectGraphFirstContext(candidateSet, selectionLimits, tightenedReserved);
    pack = buildPack(selection);
    encoded = encode(pack);
  }

  if (cacheEnabled && cache && cacheKey) {
    // Store the assembly under its fingerprint. An assembly built on a stale code index is
    // refused by the cache itself (`stale` is not a content identity).
    await cache.save({
      key: cacheKey,
      taskId: pack.task_id,
      contextPackJson: encoded,
      codeIndexDescriptor:
        codeCandidates === undefined ? CODE_INDEX_UNUSED : await currentCodeIndexDescriptor(deps.codeFs, root),
      selectedChars: encoded.length,
      selectedTokenEstimate: estimateTokensFromChars(encoded.length),
      droppedItemCount: selection.dropped.length,
      specDroppedCount: specPhase.droppedCount,
      codeContextDroppedCount,
    });
  }

  return await persistContextPack({
    fs: deps.fs,
    runtimeRoot,
    taskText,
    encoded,
    maxContextChars: budget.max_context_chars,
    cacheStatus: cacheEnabled ? "miss" : "bypass",
    droppedItemCount: selection.dropped.length,
    specDroppedCount: specPhase.droppedCount,
    codeContextDroppedCount,
    codeContextRebuilt: codeCandidates?.rebuilt ?? false,
    canaryFeatures,
    canarySizeFallback,
    ...(deps.attemptIdentity === undefined ? {} : { attemptIdentity: deps.attemptIdentity }),
    ...(deps.artifacts === undefined ? {} : { artifacts: deps.artifacts }),
  });
}

// Identity of the code index a pack's code_context was derived from. `fresh:<source_hash>`
// is a content identity; a stale or missing index yields the `stale` sentinel, which the
// cache refuses to store or match.
async function currentCodeIndexDescriptor(
  codeFs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<string> {
  const freshness = await checkCodeIndexFreshness(codeFs, projectRoot);
  if (!freshness.ok) {
    return CODE_INDEX_STALE;
  }
  const manifest =
    freshness.manifest ??
    (await codeFs
      .readTextFile(codeIndexPath(projectRoot, "manifest.json"))
      .then((raw) => JSON.parse(raw) as { source_hash?: string })
      .catch(() => undefined));
  return manifest && typeof manifest.source_hash === "string" ? `fresh:${manifest.source_hash}` : CODE_INDEX_STALE;
}
