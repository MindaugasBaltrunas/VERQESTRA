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
import { discoverControlDocCandidates, rankDiscoveredDocCandidates, selectDiscoveredDocs } from "../../code-intelligence/retrieval/discovered-docs.js";
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
import { discoveredDocsCacheSources } from "../discovered-docs-cache-sources.js";
import { codeGraphModeCacheSource, computeContextCacheKey } from "../context-cache-key.js";
import { CODE_INDEX_STALE, CODE_INDEX_UNUSED } from "../context-cache-model.js";
import { estimateTokensFromChars } from "../metrics.js";
import { COMPRESSION_FALLBACK_SIZE, compileWorkerPromptTaskForDispatch } from "../worker-prompt-compilation.js";
import { systemClock, type ContextCachePort, type ContextPackFileSystemPort } from "../ports.js";
import { explicitAllowedPaths, parseTaskMarkdown } from "./parse-task.js";
import { capSpecRetrievalWarnings, runSpecPhase, specSelectionDropWarning } from "./spec-phase.js";
import {
  autoGatherCodeContextCandidates,
  gatherCodeContextCandidates,
  type CodeContext,
  type CodeContextGatherOptions,
} from "./gather.js";
import { applyCodeContextReduction, applyCodeContextTiers, codeContextSymbolState, measureHypotheticalSourceChars } from "./tiers.js";
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
  spec_refs: [], architecture_nodes: [], allowed_paths: [], related_files: [], impacted_tests: [],
  docs_snippets: [], order: [], dropped: [], estimated_chars: 0,
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
    ...new Set([agentSelection.primary, ...agentSelection.supporting].filter((r): r is string => Boolean(r)).map((r) => r.toLowerCase())),
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
  // Šaltiniai renkami TIK kai kešas realiai naudojamas (2026-08-24, operatoriaus radinys).
  // `collectSources` perskaito ir suhash'uoja KIEKVIENĄ taikinį, spec šaltinį, architektūros ir
  // politikos failą — būtent tą darbą `--no-context-cache` ir turi praleisti. Iki tol raktas buvo
  // skaičiuojamas visada, o naudojamas tik dviejose vietose (`lookup` ir `save`), ir abi jau buvo
  // po `cacheEnabled` sąlyga: visas rinkimas nueidavo į šiukšles.
  if (cache && cacheEnabled) {
    const cacheSources = await cache.collectSources({
      taskPath,
      taskText,
      targets,
      specSources: parsedTask.specSources,
    });
    // The pack's content also depends on the compression feature flags (task 0023) AND on
    // the arrest that narrows them (task 0038) — both must invalidate cached packs. Nuo
    // task 101-c prie jų prisideda kontrolinių dokumentų medžio turinys: `docs_snippets`
    // ateina IŠ jo, tad be šių šaltinių README pataisymas grįžtų kaip `hit` su pasenusiu
    // discovered tekstu (101-b modulio antraštė aprašo, kodėl hash'uojamas EFEKTAS).
    cacheSources.push(
      ...(await contextCompressionCacheSources({ fs: deps.fs, root, runtimeRoot, arrestView })),
      ...(await discoveredDocsCacheSources({ fs: deps.codeFs, projectRoot: root })),
      codeGraphModeCacheSource(withCodeGraph),
    );
    cacheKey = computeContextCacheKey(cacheSources);
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

  // Discovered docs (task 101-c): `CONTROL_DOC_ROOTS` gabalai, kurių task'as NEĮVARDIJO. Savas
  // reitingavimas ir savas biudžetas (`discovered-docs.ts`), o atrankoje — ŽEMIAUSIAS kibiras,
  // tad įvardyto turinio jie išstumti negali. Užklausa yra task'o tikslas: BM25 nulis = jokio
  // lexinio ryšio = kandidatas krenta dar prieš biudžetą.
  const discoveredDocs = selectDiscoveredDocs(
    rankDiscoveredDocCandidates(await discoverControlDocCandidates(deps.codeFs, root), parsedTask.goal),
    selectionLimits.max_spec_fragments,
    Math.max(0, budget.max_context_chars - taskText.length),
  );

  // allowed_paths are the authoritative edit boundary: always rendered in full and never
  // trimmed — accounted for as fixed reserved overhead, not as a droppable candidate here.
  const candidateSet: GraphFirstContextCandidates = {
    specRefs: specPhase.kept.map(fragmentKey),
    architectureNodes: codeCandidates?.architectureNodes ?? [],
    allowedPaths: [],
    codeGraphNeighbors: codeCandidates?.codeGraphNeighbors ?? [],
    impactedTests: codeCandidates?.impactedTests ?? [],
    // Ta pati `${ref}\n${text}` forma kaip spec fragmentų: atranka mato realų svorį (ne vien
    // ref'ą), o renderis tą pačią formą išskaido atgal į antraštę ir kūną.
    docsSnippets: discoveredDocs.kept.map((doc) => `${doc.ref}\n${doc.text}`),
  };

  const keptFragmentsOf = (selection: GraphFirstSelection): RetrievedFragment[] =>
    selection.spec_refs.map((key) => fragmentByKey.get(key)).filter((f): f is RetrievedFragment => Boolean(f));

  /**
   * Spec ref'ai, kurių atranka NEIŠLAIKĖ: paimti kandidatai minus išlikę.
   *
   * Skaičiuojama iš SKIRTUMO, o ne iš `selection.dropped` eilučių: taip ji nepriklauso nuo tų
   * įrašų teksto formato, kurį valdo kitas modulis.
   */
  const droppedSpecRefs = (selection: GraphFirstSelection): string[] => {
    const keptKeys = new Set(selection.spec_refs);
    return specPhase.kept.filter((fragment) => !keptKeys.has(fragmentKey(fragment))).map((fragment) => fragment.ref);
  };

  // Gather'io `CodeContext` PLIUS hipotetinis SRC dydis (task 089), matuojamas kas `buildPack` iš
  // TO PATIES sąrašo, kuris eina į pack'ą: kopėčių nuleisti simboliai atsispindi savaime, o lauko
  // svoris patenka į `reservedChars`, o ne atsiranda po jo matavimo.
  const buildCodeContext = (selection: GraphFirstSelection): (CodeContext & { symbol_hypothetical_src_chars?: number }) | undefined => {
    if (codeCandidates === undefined) {
      return undefined;
    }
    const hypothetical = measureHypotheticalSourceChars(codeCandidates.symbolFragments, codeCandidates.sourceSlices);
    return {
      enabled: codeCandidates.enabled,
      related_files: [...selection.related_files],
      impacted_tests: [...selection.impacted_tests],
      architecture_nodes: [...selection.architecture_nodes],
      priority_order: selection.order,
      summary: codeCandidates.summary,
      symbol_fragments: codeCandidates.symbolFragments,
      // Nulio nerašome: `symbol_slices` išjungtas arba visi gavo SRC — pack'as lieka nepakitęs.
      ...(hypothetical > 0 ? { symbol_hypothetical_src_chars: hypothetical } : {}),
      notes: [
        ...codeCandidates.notes,
        ...(selection.dropped.length > 0 ? [`context truncated by policy limits: dropped ${selection.dropped.length} item(s)`] : []),
      ],
    };
  };

  /**
   * `droppedRefs` paduodamas ATSKIRAI, o ne išvedamas iš `selection` (2026-08-24, RAG auditas 4).
   *
   * Rezervo matavimas (`EMPTY_SELECTION`) turi atsakyti „kiek pack'as sveria BE nemetamo turinio",
   * ir praradimų įspėjimo ten dar nėra — jo tiesiog nėra ko rašyti. Išvedus jį iš selection'o,
   * tuščia atranka reikštų „viskas prarasta", ir rezervas iš anksto nupirktų vietą įspėjimui, kurio
   * dažniausiai neprireiks — o šiame pack'e ta vieta yra fragmentas.
   *
   * Perviršį, atsirandantį įspėjimui realiai atsiradus, tvarko perrinkimo ciklas žemiau. Tai saugu
   * BŪTENT todėl, kad įspėjimas yra viena eilutė su pastoviomis lubomis: jis nebeauga su kiekvienu
   * nauju praradimu, tad ciklas negali persekioti savo paties diagnostikos.
   */
  const buildPack = (selection: GraphFirstSelection, droppedRefs: string[]): ContextPack => {
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
        // Įspėjimai sudedami TIK ČIA, kai selection jau žinoma (2026-08-24, RAG auditas 4).
        // Iki tol jie buvo užrakinami spec fazėje, o graph-first atranka numesdavo spec ref'us
        // PO to — tyliai: pack'e likdavo tik bendras „dropped N item(s)" `code_context.notes`
        // viduje, o tų pastabų VISAI nėra, kai task'as neturi kodo taikinių. Worker'is gaudavo
        // nepilną specifikaciją be jokio ženklo, kad ji nepilna.
        spec_fragment_warnings: capSpecRetrievalWarnings([
          ...specPhase.warnings,
          ...[specSelectionDropWarning(droppedRefs)].filter((warning) => warning !== undefined),
        ]),
        ...(selection.docs_snippets.length > 0 ? { docs_snippets: selection.docs_snippets } : {}),
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
  let reservedChars = encode(buildPack(EMPTY_SELECTION, [])).length;

  // REF/SIG/SRC tiers (task 0023). The tier decision runs against the overhead measured
  // ABOVE — before any slice text enters the pack; the enriched symbols then become part
  // of the fixed overhead themselves.
  const notesBeforeTiers = codeCandidates ? [...codeCandidates.notes] : [];
  if (symbolSlicesEnabled && codeCandidates && codeCandidates.symbolFragments.length > 0) {
    const tiered = applyCodeContextTiers(codeCandidates, selectionLimits, reservedChars);
    codeCandidates.symbolFragments = tiered.symbols;
    codeCandidates.notes.push(...tiered.notes);
    reservedChars = encode(buildPack(EMPTY_SELECTION, [])).length;
  }

  const droppableKept = (selection: GraphFirstSelection): number =>
    selection.spec_refs.length + selection.architecture_nodes.length + selection.related_files.length +
    selection.impacted_tests.length + selection.docs_snippets.length;

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
      reservedChars = encode(buildPack(EMPTY_SELECTION, [])).length;
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
  let pack = buildPack(selection, droppedSpecRefs(selection));
  let encoded = encode(pack);
  while (encoded.length > budget.max_context_chars && droppableKept(selection) > 0) {
    // Tightened against the SELECTION ceiling the estimate was produced by, so the next
    // pass gives up exactly one more lowest-priority item.
    const tightenedReserved = selectionLimits.max_context_chars - (selection.estimated_chars - 1);
    selection = selectGraphFirstContext(candidateSet, selectionLimits, tightenedReserved);
    pack = buildPack(selection, droppedSpecRefs(selection));
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

/**
 * Identity of the code index a pack's `code_context` was derived from.
 *
 * Formatas: `fresh:<indekso versija>:<source_hash>:<records_hash>`.
 *
 * Trys dedamosios, ir kiekviena uždaro tai, ko ankstesnė nemato:
 *
 *   • `source_hash` — ĮVESTIS (kokius failus indeksas matė). Vienas jis buvo iki 2026-08-23, ir to
 *     nepakako: pakėlus `codeIndexVersion` tie patys failai duoda tą patį hash'ą, tad senas pack'as,
 *     sudėtas iš SKURDESNIO indekso, grįždavo kaip pilnavertis hit'as.
 *   • `<versija>` — DEKLARUOTA semantika. Uždarė aną spragą struktūriškai, bet ji remiasi RANKINIU
 *     kontraktu: kas keičia ištraukimo logiką, privalo prisiminti pakelti versiją.
 *   • `records_hash` — faktinė IŠVESTIS (2026-08-24, operatoriaus siūlymas). Jis mato tai, ką
 *     indeksuotojas realiai pagamino, tad pakeitus logiką be versijos kėlimo pack'ai anuliuojami
 *     VIS TIEK. Tai ta pati kryptis, kuria ėjo versijos įtraukimas — tik viena pakopa giliau:
 *     nuo „ką deklaruojame" prie „ką iš tikrųjų turime".
 *
 * Ko tai NEKEIČIA: priverstinis perstatymas su nepakitusiais failais toliau duoda HIT'Ą, ir taip
 * turi būti — build'as deterministinis (`characterization-code-index`: du perstatymai baitas į
 * baitą), tad `records_hash` sutampa. Kešas, praleidžiantis nepakitusį indeksą, veikia teisingai.
 *
 * Kešo versijos kelti nereikia: seni įrašai neša trumpesnį deskriptorių, tad jie nebeatitiks ir
 * natūraliai taps `code_index_drift` miss'ais — deskriptorius anuliuoja pats save.
 *
 * Neperskaitomas arba pasenęs indeksas duoda `stale` sentinelį, kurio kešas nei saugo, nei atitinka.
 */
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
    (await codeFs.readTextFile(codeIndexPath(projectRoot, "manifest.json"))
      .then((raw) => JSON.parse(raw) as { source_hash?: string; version?: string; records_hash?: string })
      .catch(() => undefined));
  if (!manifest) return CODE_INDEX_STALE;
  // Visos trys dedamosios imamos iš PATIES manifesto, o ne iš proceso konstantų: deskriptorius turi
  // aprašyti indeksą, iš kurio pack'as SUDĖTAS, o ne šio proceso build'ą. Manifestas, kuriame bent
  // vienos nėra (senesnė forma), yra neapibūdinamas, tad laikomas pasenusiu.
  const parts = [manifest.version, manifest.source_hash, manifest.records_hash];
  return parts.every((part) => typeof part === "string" && part !== "")
    ? `fresh:${parts.join(":")}`
    : CODE_INDEX_STALE;
}
