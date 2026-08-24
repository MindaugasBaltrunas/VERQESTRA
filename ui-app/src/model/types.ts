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

export type PolicyProposalRouting = "queue" | "openspec" | "human-review";

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
  pending_proposal?: PolicyProposal | string;
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
  loop_controls: Array<{ id: "resume" | "stop"; label: string; endpoint: string; method: "POST" }>;
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
};

/**
 * Worker slot'ų PRAŠYMAS (task 0051) — tiksliai tai, ką grąžina `POST /api/runtime/workers`.
 * Paskutinės bangos rezultato čia nėra: jį žino tik snapshot'as, o ne prašymo saugykla.
 */
export type WorkerRequestState = {
  requested: number;
  /** `env` reiškia, kad reikšmę diktuoja `AG_MAX_WORKERS` ir ekrano valdiklis nieko nekeičia. */
  source: "env" | "state" | "default";
  envOverride: boolean;
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
  decision: { verdict?: string; reason?: string };
  supervisorResume: ResumeSummary;
  claudeResume: ResumeSummary;
  runtime: RuntimeProcess[];
  claudeLogUpdatedAt: string | null;
  claudeLogBytes: number | null;
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
};

export type BenchmarkReportView = {
  state: BenchmarkReportState;
  reason?: string;
  source: { path: string; command: string };
  freshness: { reportedAgCommit?: string; currentAgCommit?: string };
  report?: BenchmarkReportDocument;
};

/* ---- `GET /api/waves` (`interfaces/http/ui-waves-view.ts#UiWavesView`) -----------------------
 * DTO gyvena čia, o ne kontroleryje: bangų duomenis dabar skaito ir model sluoksnis
 * (`slotProgressViewModel`, `queuePipelineViewModel`), o modelis kontrolerio importuoti negali —
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
