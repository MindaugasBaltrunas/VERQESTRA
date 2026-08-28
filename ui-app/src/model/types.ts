export type TaskBucket =
  | "queue"
  | "active"
  | "delegated"
  | "error"
  | "failed"
  | "human-review"
  | "done";

export type ResumeSummary = {
  phase?: string;
  status?: string;
  task_id?: string;
  log_file?: string;
  log_bytes?: number;
  log_lines?: number;
  next_action?: string;
  updated_at?: string;
};

export type RuntimeProcess = {
  name: string;
  pid?: number;
  status: "running" | "stopped" | "unknown";
  detail?: string;
};

export type WorkflowBucket = {
  name: TaskBucket;
  tasks: string[];
  totalCount?: number;
};

export type UiConfigControl = {
  id: string;
  label: string;
  value: boolean | string | number;
  source: string;
  editable: boolean;
  command?: string;
};

/**
 * Maršrutai, kuriuos serveris REALIAI gali atsiųsti (`POLICY_ROUTINGS`).
 *
 * `"openspec"` pašalintas 2026-08-24 (dublikatų auditas): serverio `z.enum(POLICY_ROUTINGS)` jo
 * neleidžia, tad ta reikšmė laidu niekada neatkeliaudavo. Sąjungos narys, kurio wire negali
 * atnešti, nėra nekaltas — jis kviečia parašyti `if (routing === "openspec")` šaką, kuri niekada
 * neįvyks, ir atrodys kaip veikianti. Sutapimą su serveriu nuo šiol laiko vartas
 * (`src/tests/ui-restated-contracts.test.ts`), ne šis komentaras.
 */
export type PolicyProposalRouting = "queue" | "human-review";

export type PolicyProposal = {
  policy_file: string;
  setting_id: string;
  old_value: unknown;
  requested_value: unknown;
  reason: string;
  timestamp: string;
  routing: PolicyProposalRouting;
};

export type PolicyProposalStatus = "pending" | "approved" | "rejected" | "applied";

export type PolicyDecision = {
  policy_file: string;
  setting_id: string;
  decision: "approved" | "rejected" | "applied";
  actor: string;
  reason: string;
  timestamp: string;
};

export type ResolvedProposal = {
  proposal: PolicyProposal;
  status: PolicyProposalStatus;
  history: PolicyDecision[];
};

export type UiPolicyControl = {
  id: string;
  label: string;
  value: boolean | string | number;
  source: string;
  editable: boolean;
  route?: string;
  allowed_values?: string[];
  /** NAUJAUSIAS laukiantis pasiūlymas — vienam laukui viena reikšmė. */
  pending_proposal?: PolicyProposal | string;
  /**
   * Kiek pasiūlymų laukia ŠIAM nustatymui. Serveris siunčia tik kai jų >1.
   *
   * Be jo suspaudimas iki naujausio buvo tylus: suvestinė skaičiavo NUSTATYMUS, sprendimų eilė —
   * PASIŪLYMUS, ir skirtumas ekrane atrodė kaip dublikatas be paaiškinimo.
   */
  pending_proposal_count?: number;
};

export type UiPolicyGroup = {
  group: string;
  label: string;
  controls: UiPolicyControl[];
};

export type UiHumanReviewTask = {
  file: string;
  task_id: string;
  title: string;
  blocked_by?: string;
  reason?: string;
  preview: string;
  actions: string[];
};

export type UiLearningRecommendation = {
  id: string;
  status: "pending" | "approved" | "rejected";
  summary: string;
  labels: string[];
  evidence: string[];
  task_id?: string;
  file?: string;
  actions: string[];
};

export type UiControlPlaneData = {
  config_controls: UiConfigControl[];
  // `loop_controls` PAŠALINTAS 2026-08-24 abiejose pusėse: serveris siuntė maršrutus
  // (`/tasks/resume`, `/tasks/stop`), kuriuos klientas turi savo `api.ts` ir skaito IŠ TEN.
  // Nenaudojamas endpoint'as atsakyme atrodo kaip autoritetas — pervadinus maršrutą kiltų pagunda
  // taisyti jį, o realus kelias liktų senas.
  human_review_tasks: UiHumanReviewTask[];
  learning_recommendations: UiLearningRecommendation[];
  learning_summary: {
    records: number;
    by_type: Record<string, number>;
    pending_recommendations: number;
    approved_recommendations: number;
    rejected_recommendations: number;
  };
  policy_controls?: UiPolicyGroup[];
  /** Projekto stack sprendimas su pasitikėjimu ir human-review vėliava. */
  stack_decision?: UiStackDecision;
  /** Token biudžeto lubos ir suvartojimas — atsakymas „kodėl dispatch'as pristabdytas". */
  token_budget?: UiTokenBudget;
};

export type UiStackDecision = {
  selected_language: string | null;
  selected_framework: string | null;
  architecture_style: string;
  confidence: "high" | "medium" | "low";
  human_review_required: boolean;
  reason: string;
};

/** Lubos iš galiojančio profilio; `null` reiškia „neribota". */
export type UiTokenBudgetLimits = {
  max_llm_calls: number | null;
  max_total_llm_calls: number | null;
  max_total_tokens: number | null;
};

/**
 * Du blokus rašo SKIRTINGI momentai, tad jie nesuliejami: bendras skaičius, sudėtas iš dviejų
 * laiko taškų, meluotų apie abu. Visi laukai optional — dalinis ar senesnio formato turinys
 * privalo būti praleistas, o ne versti ekraną.
 */
export type UiTokenBudget = {
  budget_enforcement?: {
    ok?: boolean;
    task_id?: string;
    model?: string;
    profile?: string;
    llm_calls?: number;
    total_llm_calls?: number;
    total_tokens?: number;
    billable_tokens?: number;
    limits?: UiTokenBudgetLimits;
    reduce_context?: boolean;
    reasons?: string[];
    soft_reasons?: string[];
  };
  llm_call_authorization?: {
    allowed?: boolean;
    task_id?: string;
    phase?: string;
    total_llm_calls?: number;
    total_tokens?: number;
    billable_tokens?: number;
    remaining_total_llm_calls?: number | null;
    remaining_total_tokens?: number | null;
    reduce_context?: boolean;
    hard_reasons?: string[];
    soft_reasons?: string[];
  };
};

/**
 * Worker slot'ų PRAŠYMAS (task 0051) — tiksliai tai, ką grąžina `POST /api/runtime/workers`.
 * Paskutinės bangos rezultato čia nėra: jį žino tik snapshot'as, o ne prašymo saugykla.
 */
export type WorkerRequestState = {
  requested: number;
  /**
   * `env` reiškia, kad reikšmę diktuoja `AG_MAX_WORKERS` ir ekrano valdiklis nieko nekeičia —
   * `adaptWorkerControl` būtent iš čia išveda `canEdit`.
   *
   * Šalia iki 2026-08-24 keliavo `envOverride: boolean`, visada lygus `source === "env"`, ir jo
   * neskaitė nė viena pusė. Pašalintas: du to paties fakto pavidalai viename atsakyme anksčiau ar
   * vėliau prasilenkia, o prasilenkę nepasako, kuris teisus.
   */
  source: "env" | "state" | "default";
  /**
   * Prašymo failas yra, bet nepanaudojamas — loop'as naudoja vieną workerį. KODAS, ne žinutė:
   * serveris sąmoningai nesiunčia fs/JSON teksto su absoliučiais keliais.
   */
  invalid?: "unreadable" | "malformed" | "schema";
};

/**
 * Valdiklio duomenys dashboard'e: prašymas KARTU su paskutinės bangos atsakymu į jį. Abu rodomi
 * sąmoningai — prašyti dviejų workerių nereiškia jų gauti, ir vartotojas turi matyti, kiek slot'ų
 * banga realiai išdavė bei kodėl likusieji atmesti.
 */
export type WorkerControlData = WorkerRequestState & {
  lastWave: {
    mode: string;
    requested: number;
    granted: number;
    max: number;
    rejected: Array<{ task_id: string; reason: string; detail: string }>;
  } | null;
};

/** Ko operatorius NORI iš srauto. `drain` — užbaigti vykdomą attempt'ą ir naujo neskirti. */
export type LoopSlotMode = "run" | "drain" | "abort";

/**
 * Kas su srautu vyksta IŠ TIKRŲJŲ. `aborting`, o ne `aborted`: valdiklis vykdomo bandymo
 * NENUTRAUKIA — jis įsigalioja artimiausiame saugiame taške (serverio `ui/loop-control-service.ts`).
 */
export type LoopSlotState = "running" | "draining" | "aborting" | "idle";

export type LoopWorkerId = "w1" | "w2";

/**
 * Vieno srauto (worker slot'o) faktinė būsena. `desired` ir `state` yra DU skirtingi faktai:
 * „operatorius sustabdė" ir „banga slot'o neišdavė" ekrane atrodo vienodai (nieko nevyksta), bet
 * reikalauja skirtingo veiksmo — antrąjį paaiškina `lastWave.rejected_reason`.
 */
export type LoopSlotData = {
  worker_id: LoopWorkerId;
  worker_index: 1 | 2;
  desired: LoopSlotMode;
  state: LoopSlotState;
  task_id: string | null;
  attempt: number | null;
  /** `granted` yra bangos IŠDUOTŲ slot'ų SKAIČIUS (ne šio slot'o vėliava) — žr. `adaptLoopControl`. */
  lastWave: { wave_id: string; granted: number; rejected_reason: string | null } | null;
};

export type LoopControlData = {
  loop: { status: "running" | "stopped" | "unknown"; stopRequested: boolean };
  slots: LoopSlotData[];
  /**
   * Valdymo failas yra, bet nepanaudojamas — visi srautai lieka `run`. KODAS, ne žinutė: serveris
   * sąmoningai nesiunčia fs/JSON teksto su absoliučiais keliais (tas pats principas kaip
   * `WorkerRequestState.invalid`).
   */
  invalid?: "unreadable" | "malformed" | "schema";
};

export type DashboardData = {
  root: string;
  currentTaskId: string | null;
  currentTaskFile: string | null;
  currentTaskBucket?: TaskBucket | null;
  currentTaskState?: "active" | "stale" | "none";
  claudeExit: string | null;
  stableRef: string | null;
  stopStatus: { status?: string; reason?: string };
  /**
   * Kuris stop įrodymas priimtas: `attempt` (šio bandymo `stop-state.json`), `legacy` (globalus
   * veidrodis, galintis priklausyti KITAM task'ui) ar `none`.
   *
   * Neprivalomi dėl senesnio `dist`, bet PRIVALOMI prasmei: serveris juos siunčia su komentaru
   * „kilmė rodoma, o ne nutylima", ir iki 2026-08-24 tai buvo pažadas, kurio klientas nevykdė.
   */
  stopStatusSource?: string;
  /** Įrodymas RASTAS, bet neperskaitomas. Serveris tokiu atveju SĄMONINGAI nenusileidžia prie legacy. */
  stopStatusCorrupted?: boolean;
  decision: { verdict?: string; reason?: string };
  supervisorResume: ResumeSummary;
  claudeResume: ResumeSummary;
  runtime: RuntimeProcess[];
  claudeLogUpdatedAt: string | null;
  claudeLogBytes: number | null;
  /** `attempt` | `legacy` | `none` — `legacy` antspaudas gali priklausyti KITAM task'ui. */
  claudeLogSource?: string;
  workflowBuckets: WorkflowBucket[];
  queueCounts?: Record<string, number>;
  statusFiles?: Array<{ name: string; present: boolean; bytes?: number; updatedAt?: string }>;
  controlPlane?: UiControlPlaneData;
  /** Neprivalomas: senesnis UI serveris (senas `dist`) šio bloko dar nesiunčia. */
  workerControl?: WorkerControlData;
  /** Neprivalomas dėl tos pačios priežasties: senas `dist` srautų būsenos nesiunčia. */
  loopControl?: LoopControlData;
  /**
   * Šaltiniai, kurių serveris NEPERSKAITĖ (`ui-dashboard-view.ts#degraded`).
   *
   * Dashboard'as yra diagnostikos paviršius, tad sugadintas artefaktas virsta įvardytu
   * degradavusiu bloku, o ne 500 — bet TIK tada, kai vardas pasiekia ekraną. Neprivalomas dėl
   * senesnio `dist`, kuris šio lauko dar nesiunčia; jo nebuvimas reiškia „nežinome", ne „viskas
   * perskaityta", todėl kontroleris jį verčia tuščiu sąrašu tik po `?? []`.
   */
  degraded?: string[];
};

export type LoopResult = {
  status: "already-running" | "started" | "failed";
  pid?: number;
  reason?: string;
};

export type LoopStopResult = {
  /**
   * `stop-requested-no-known-process`: vėliava įrašyta, bet gyvo, šiam UI žinomo loop proceso
   * nėra (pvz. loop'as paleistas terminale). Anksčiau toks atvejis grąžindavo `stop-requested`
   * ir dashboard rodydavo „stopping after task", nors nieko nevyko (2026-08-06 UI auditas).
   */
  status: "stop-requested" | "stop-requested-no-known-process" | "failed";
  pid?: number;
  reason?: string;
};

export type UploadResult = {
  // Server (`uploadQueueMarkdownFiles`) returns the saved queue filenames, not a
  // count — this mirrors the `{ saved, loop }` shape written by the upload route
  // in `interfaces/http/ui-server.ts`. Kept as `string[]` to match the wire type.
  saved: string[];
  loop: LoopResult;
};

export type AgentStatus = "done" | "error" | "active" | "pending";

export type AgentActivity = {
  chain: string[];
  statuses: Record<string, AgentStatus>;
  currentAgent: string | null;
  currentActivity: string | null;
  taskId: string | null;
  claudeStatus: string | null;
  /**
   * How the chain is being executed: `subagents` — Claude spawned real subagents;
   * `inline` — one headless Claude is working directly, no subagents; `idle` — no
   * active run. Mirrors `AgentActivity["mode"]` in `src/ui/agent-parser.ts`.
   */
  mode: "subagents" | "inline" | "idle";
  updatedAt: string;
};

/**
 * VIENO gyvo srauto agentų grandinė — `/api/events` krovinio `slots[]` įrašas.
 *
 * Kodėl jis egzistuoja (serverio `UiSlotActivity`): globalus `AgentActivity` yra projekcija ant
 * VIENO `claude-last.log`, kurį lygiagretūs worker'iai perrašo vienas per kitą. Antram srautui tai
 * reiškia SVETIMĄ grandinę ir svetimą fazę. Kiekvienas šio sąrašo įrašas ateina iš SAVO bandymo
 * log'o, tad priklauso būtent tam srautui — spėlioti pagal `task_id` nebereikia.
 */
export type SlotAgentActivity = {
  worker_id: string;
  task_id: string;
  attempt: number;
  /** Repo-relatyvus kelias, IŠ KURIO įrašas išparsintas — kilmė rodoma, o ne nutylima. */
  log_path: string;
  activity: AgentActivity;
};

/** `/api/events` kadras: globalus aktyvumas plius per-srautinis, kai banga turi gyvų slot'ų. */
export type AgentActivityFrame = AgentActivity & {
  stopStatusSource?: string;
  slots?: SlotAgentActivity[];
};

export type TokenUsageRecord = {
  ts: string;
  phase: string;
  task_id: string;
  model: string;
  attempt?: number;
  attempt_id?: string;
  parent_attempt_id?: string;
  outcome?: "succeeded" | "failed" | "infrastructure";
  retry_reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
};

// `GET /api/token-usage` returns only the filtered records. The client is the
// single aggregation site (`model/tokenUsageViewModel.ts`) — it recomputes
// every rollup from `records` so the client-only `task_id` substring filter is
// always honoured. The server no longer sends a `summary` block (audit 2026-07,
// task 936).
export type TokenUsageQueryResponse = {
  records: TokenUsageRecord[];
  pagination?: {
    total_records: number;
    returned_records: number;
    offset: number;
    limit: number | null;
    has_more: boolean;
  };
};

// Server-side query filters accepted by GET /api/token-usage. `task_id` is
// intentionally excluded here — the server does exact-match filtering on it,
// but the UI needs substring search, so `task_id` is always applied client-side.
export type TokenUsageServerFilter = {
  model?: string;
  phase?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

// GET /api/token-analytics — the learning layer on top of token-usage (task 894):
// similar-task grouping, optimization candidates, and a long-term snapshot
// history. Grouping/outlier detection happen server-side (orchestrator/
// similar-task-analytics.ts) since they need the full, unfiltered log history,
// not just the client's current filter selection.
export type TaskFamilyGroup = {
  familyKey: string;
  taskIds: string[];
  totalTokensByTask: Record<string, number>;
  totalRecords: number;
  totalTokens: number;
  medianTokens: number;
};

export type OptimizationCandidate = {
  taskId: string;
  familyKey: string;
  taskTokens: number;
  groupMedianTokens: number;
  multiplier: number;
  reasonHint: string;
};

export type TokenAnalyticsBucket = { key: string; totalTokens: number };

export type TokenAnalyticsSnapshot = {
  generatedAt: string;
  totals: { records: number; totalTokens: number; uniqueTasks: number };
  tokensByPhase: TokenAnalyticsBucket[];
  tokensByModel: TokenAnalyticsBucket[];
  tokensByDay: TokenAnalyticsBucket[];
  fastPathHitRate: { preflight: number; diagnose: number };
  cacheHitRate: number;
  repairShare: number;
  groupMedians: Array<{ familyKey: string; taskCount: number; medianTokens: number }>;
};

export type TokenAnalyticsResponse = {
  groups: TaskFamilyGroup[];
  candidates: OptimizationCandidate[];
  history: TokenAnalyticsSnapshot[];
};

// GET /api/benchmark/report — read-only view over the authoritative VERQESTRA
// benchmark report (BENCH-10, BENCH-11). Mirrors
// `interfaces/http/BenchmarkReportView` / `BenchmarkReportDocument` on the
// server (`application/benchmark/suite-report-view.ts`), which itself mirrors
// the `AG/benchmark` package's report model. The UI reads these fields; it
// never recomputes a rate or a cost from them.
export type BenchmarkReportState = "available" | "stale" | "corrupt" | "missing";

export type BenchmarkExecutionMode = "ag-loop" | "agent-solo" | "deterministic-control";

export type BenchmarkComparisonVerdict = "improved" | "stable" | "regressed" | "inconclusive";

export type BenchmarkVerdictBasis = "comparison" | "no-baseline";

export type BenchmarkReportIdentity = {
  suiteHash: string;
  configHash: string;
  policyHash: string;
  agCommit: string;
  modeAdapterVersions: Array<{ mode: BenchmarkExecutionMode; version: string }>;
};

export type BenchmarkReportEnvironment = {
  platform: string;
  arch: string;
  nodeVersion: string;
  cpuCount: number;
};

export type BenchmarkReportRunFacts = {
  identity: BenchmarkReportIdentity;
  environment: BenchmarkReportEnvironment;
  sampleCount: number;
  modes: BenchmarkExecutionMode[];
};

export type BenchmarkMetricRow = {
  metric: string;
  kind: "rate" | "cost";
  baseline?: number;
  current?: number;
  absoluteDelta?: number;
  relativeDelta?: number;
};

export type BenchmarkModeDifference = {
  aspect: "model" | "prompt" | "limits" | "telemetry";
  code: string;
  detail: string;
};

export type BenchmarkModeSection = {
  mode: BenchmarkExecutionMode;
  baselineSampleCount?: number;
  currentSampleCount?: number;
  metrics: BenchmarkMetricRow[];
  differences: BenchmarkModeDifference[];
};

export type BenchmarkDistributionStatistics = {
  count: number;
  median: number;
  mean: number;
  min: number;
  max: number;
  standardDeviation: number;
  successCount: number;
};

export type BenchmarkScenarioSection = {
  scenarioId: string;
  mode: BenchmarkExecutionMode;
  verdict: BenchmarkComparisonVerdict;
  reasons: string[];
  baseline: BenchmarkDistributionStatistics;
  current: BenchmarkDistributionStatistics;
};

export type BenchmarkReportDocument = {
  schemaVersion: number;
  verdict: BenchmarkComparisonVerdict;
  verdictBasis: BenchmarkVerdictBasis;
  reasons: string[];
  current: BenchmarkReportRunFacts;
  baseline?: BenchmarkReportRunFacts;
  modes: BenchmarkModeSection[];
  scenarios: BenchmarkScenarioSection[];
  limitations: string[];
  reproduction: { arguments: string[]; command: string };
  /** Neprivaloma: ataskaita, kurios kohortos niekas nesuvedė, apie kompresiją NIEKO nesako. */
  compression?: BenchmarkCompressionSection;
};

/**
 * Kompresijos kohorta (`AG/benchmark` `ReportCompressionSection`).
 *
 * Iki 2026-08-24 paketas ją skaičiavo ir siuntė, o dashboard'as neturėjo net tipo — visas
 * canary vs control eksperimentas, dėl kurio kompresija apskritai falsifikuojama, likdavo
 * nematomas. Sąjunga sutampa su paketo `COMPRESSION_VERDICTS`; tą laiko
 * `src/tests/benchmark-restated-contracts.test.ts`.
 */
export type BenchmarkCompressionVerdict = "accepted" | "rejected" | "not_measured";

export type BenchmarkCompressionUsage = {
  totalTokens?: number;
  billableTokens?: number;
  nonCachedTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  turnsPerTask?: number;
};

export type BenchmarkCompressionVariant = {
  variantId: string;
  variantIdentity: string;
  features: string[];
  hookProfile: string;
  sampleCount: number;
  conclusiveCount: number;
  /** Kiek baigtinių bandymų turėjo UŽFIKSUOTĄ suvartojimą; žemiau jo KPI atsisakoma. */
  capturedUsageCount: number;
  verdict: BenchmarkCompressionVerdict;
  reasons: string[];
  /** Pagrindinis KPI: apmokestinami tokenai vienam priimtam task'ui. */
  billableTokensPerAcceptedTask?: number;
  /** Judėjimas prieš baseline (`variantas - baseline`); neigiamas yra pigiau. */
  billableTokensPerAcceptedTaskDelta?: number;
  billableTokensPerAcceptedTaskRelativeDelta?: number;
  /** Saugos KPI: žalias srautas tuo pačiu vardikliu, su savo slenksčiu. */
  rawTokensPerAcceptedTask?: number;
  rawTokensPerAcceptedTaskDelta?: number;
  rawTokensPerAcceptedTaskRelativeDelta?: number;
  acceptedRate?: number;
  securityFailureRate?: number;
  outOfScopeRate?: number;
  repairsPerTask?: number;
  humanReviewEventsPerTask?: number;
  usage: BenchmarkCompressionUsage;
  /** Simbolių skaitikliai prieš baseline. DIAGNOSTIKA: jokio verdikto jie nesprendžia. */
  diagnostics: BenchmarkMetricRow[];
};

/**
 * Kiek prisidėjo VIENA funkcija, išmatuota ant jos pačios vieno-požymio varianto.
 *
 * Ženklas priešingas eilučių deltoms tyčia: čia tai SUTAUPYMAS (`baseline - variantas`), tad
 * teigiamas skaičius yra neišleisti pinigai. Klientas ženklo neverčia — jį verstų atbulai.
 */
export type BenchmarkCompressionContribution = {
  feature: string;
  /** Variantas, ant kurio išmatuota, arba `""`, kai kohorta tokio nedeklaruoja. */
  variantId: string;
  contribution?: number;
  relativeContribution?: number;
};

export type BenchmarkCompressionCombination = {
  variantId: string;
  featureContributions: BenchmarkCompressionContribution[];
  /** Apatinė riba, kai bent vienas vieno-požymio variantas nepaleistas. */
  sumOfSingleFeatureContributions?: number;
  observedCombinationContribution?: number;
  /** Stebėta minus suma. Faktas apie derinį, nepriskiriamas nė vienai funkcijai. */
  interactionResidual?: number;
};

export type BenchmarkCompressionSection = {
  registryVersion: number;
  /** KPI apibrėžimo versija — be jos dvi ataskaitos gali matuoti skirtingus dydžius tuo pačiu vardu. */
  costKpiVersion: number;
  baselineVariantId: string;
  variants: BenchmarkCompressionVariant[];
  combination?: BenchmarkCompressionCombination;
  /** Bandymai, nepriklausantys nė vienam deklaruotam variantui: į jokį agregatą jie NEĮĖJO. */
  unattributedSampleCount: number;
  limitations: string[];
};

export type BenchmarkReportView = {
  state: BenchmarkReportState;
  reason?: string;
  source: { path: string; command: string };
  freshness: { reportedAgCommit?: string; currentAgCommit?: string };
  report?: BenchmarkReportDocument;
};

/* ---- `GET /api/compression` (`interfaces/http/ui-compression-view.ts#UiCompressionView`) -----
 * Kompresijos vėliavos ir jų shadow telemetrija. `canarySupported` ateina IŠ SERVERIO, o ne iš
 * čia perrašyto sąrašo: `bash_output_digest` canary nepalaiko, ir dropdown, siūlantis reikšmę,
 * kurią serveris atmes, yra blogesnis už jos nebuvimą.
 */
export type CompressionFeatureKey =
  | "worker_task_ir"
  | "compact_dsl"
  | "symbol_slices"
  | "bash_output_digest"
  | "dispatch_tool_schema";

/** `true` = visiems, `false` = niekam, `"canary"` = tik kohortai. */
export type CompressionFeatureValue = boolean | "canary";

export type CompressionFeature = {
  key: CompressionFeatureKey;
  value: CompressionFeatureValue;
  canary_supported: boolean;
  /** Vėliavos, kurios privalo būti ≠ `false`, kad ši vėliava iš tiesų veiktų. Rakto nebuvimas = jokių priklausomybių. */
  requires?: CompressionFeatureKey[];
  /**
   * Užpildoma TIK kai `value` deklaruoja vėliavą aktyvia, o bent viena `requires` vėliava yra
   * `false` — serveris ją fail-closed priverstinai išjungtų vykdymo metu, kad ir ką rodo `value`.
   */
  inactive_reason?: "inactive_due_to_dependency";
};

export type CompressionTelemetry = {
  sample_count: number;
  latest_ts?: string;
  avg_budget_percent?: number;
  max_budget_percent?: number;
  exceeded_count: number;
  /** Kiek pavyzdžių turėjo ir `raw`, ir `compiled` dydį — tik jie palyginami. */
  ir_compared_count: number;
  /** Kiek jų IR forma buvo MAŽESNĖ. `ir_smaller_count < ir_compared_count` = nauda nevienoda. */
  ir_smaller_count: number;
  /** Vidutinė delta procentais: neigiama = IR mažesnis (nauda), teigiama = didesnis (žala). */
  avg_ir_delta_percent?: number;
  /**
   * Kuri pora sudarė `ir_*` skaičius. Prompt'o lygio pora turi pirmenybę kiekvienam mėginiui, kai
   * jis ją turi; task'o lygio pora naudojama tik tiems mėginiams, kur prompt'o poros nėra. Nebūna,
   * kai `ir_compared_count` yra 0 — tada nėra ko įvardyti.
   */
  ir_pair?: CompressionIrPair;
};

/**
 * Serverio ištartas verdiktas (`decideCompression`). Puslapis jo NESKAIČIUOJA — tik verčia
 * kodus į sakinius: spaudimo lygis + rekomendacija kiekvienai vėliavai, įskaitant sąžiningą
 * „unmeasured" toms, kurioms shadow matavimo apskritai nėra.
 */
export type CompressionPressureLevel = "insufficient" | "none" | "moderate" | "high";

export type CompressionAction = "enable" | "optional" | "hold" | "insufficient" | "unmeasured";

/** Kuri pora informavo shadow palyginimą: prompt'o lygio (task 0032) ar task'o lygio (fallback). */
export type CompressionIrPair = "prompt" | "task";

export type CompressionRecommendation = {
  key: CompressionFeatureKey;
  action: CompressionAction;
  reason: string;
  /** Verdikto šaltinis: kuri pora buvo naudota šiai rekomendacijai — kad UI galėtų įvardyti KAS lyginama. */
  pair?: CompressionIrPair;
};

export type CompressionDecision = {
  pressure: { level: CompressionPressureLevel };
  recommendations: CompressionRecommendation[];
};

export type CompressionView = {
  version: number;
  canary: { percent: number; salt: string };
  features: CompressionFeature[];
  telemetry: CompressionTelemetry;
  decision: CompressionDecision;
  degraded: string[];
};

/* ---- `GET /api/waves` (`interfaces/http/ui-waves-view.ts#UiWavesView`) -----------------------
 * DTO gyvena čia, o ne kontroleryje: bangų duomenis dabar skaito ir model sluoksnis
 * (`slotProgressViewModel`), o modelis kontrolerio importuoti negali —
 * tai apverstų sluoksnių kryptį. Kontroleris šiuos tipus re-eksportuoja, kad seni importai veiktų.
 */
export type UiWaveEvent = {
  ts: string;
  event: string;
  task_id?: string;
  reason?: string;
};

export type UiWaveLease = {
  worker_id: string;
  task_id: string;
  status: string;
  expires_at: string;
  has_worktree: boolean;
};

export type UiWaveRejection = {
  task_id: string;
  reason: string;
  detail: string;
};

export type UiWaveSlotState = "provisioned" | "running" | "failed" | "released";

export type UiWaveSlotFailure = {
  ts: string;
  task_id: string;
  reason: string;
};

export type UiWaveSlot = {
  worker_id: string;
  task_id: string;
  state: UiWaveSlotState;
  lease_status: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  lease_age_ms: number | null;
  heartbeat_age_ms: number | null;
  stale: boolean;
  has_worktree: boolean;
  last_failure: UiWaveSlotFailure | null;
};

/**
 * `/api/waves` šį lauką jau siunčia (`ui-waves-view.ts`), bet klientinio tipo jam nebuvo, tad
 * papildymo sprendimai ekrano nepasiekdavo. `hard_capped` yra SKAIČIUS (kiek slot'ų nukirsta),
 * ne vėliava.
 */
export type UiWaveRefillDecision = {
  episode: number;
  worker_id: string;
  task_id: string;
  granted: boolean;
  reason: string;
  hard_capped: number;
  decided_at: string;
  rejected: UiWaveRejection[];
};

export type UiWavesView = {
  events: UiWaveEvent[];
  leases: UiWaveLease[];
  /** Neprivalomas: senesnis serveris `slots` negrąžina, ir vaizdas tada lieka prie lease'ų lentelės. */
  slots?: UiWaveSlot[];
  last_rejections: UiWaveRejection[];
  /** Neprivalomas dėl tos pačios priežasties: senas `dist` papildymo sprendimų nesiunčia. */
  refill_decisions?: UiWaveRefillDecision[];
  degraded: string[];
};

export type ReliabilityAnalyticsResponse = {
  generatedAt: string;
  coverage: {
    gitSinceDays: number;
    gitAvailable: boolean;
    taskEvents: number;
    tokenRecords: number;
    limitations: string[];
  };
  files: {
    session: { touched: number; created: number; modified: number; deleted: number };
    today: { created: number; modified: number; deleted: number; commits: number; uniqueFiles: number };
    week: { created: number; modified: number; deleted: number; commits: number; uniqueFiles: number };
    byDay: Array<{ date: string; created: number; modified: number; deleted: number; commits: number; uniqueFiles: number }>;
    byExtension: Array<{ extension: string; files: number }>;
  };
  reliability: {
    failures: number;
    fixed: number;
    open: number;
    fixRate: number;
    medianRepairMinutes?: number;
    incidentTokens: number;
    repairTokens: number;
    diagnosticTokens: number;
    retryTokens: number;
    cacheTokens: number;
    byType: Array<{ type: string; count: number; fixed: number; open: number }>;
    byDay: Array<{ date: string; fixed: number; open: number; incidentTokens: number; repairTokens: number; diagnosticTokens: number; retryTokens: number; cacheTokens: number }>;
    records: Array<{
      taskId: string;
      failedAt: string;
      fixedAt?: string;
      status: "fixed" | "open";
      type: string;
      phase: string;
      reason: string;
      detail?: string;
      totalTokens: number;
      repairTokens: number;
      diagnosticTokens: number;
      retryTokens: number;
      cacheTokens: number;
    }>;
  };
};
