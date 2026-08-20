/** Effect ports and data contracts consumed by the canonical task run coordinator. */
import type { TaskBucket } from "../../domain/tasks/index.js";
import type { PreflightFailureMemoRecord } from "../quality-gates/preflight-memo-schema.js";
import type { IntegrationEnforcementMode } from "../integration/wave-gates-schema.js";
import { type EvaluateIntegrationRiskInput, type IntegrationRiskVerdict } from "../integration/evaluate-integration-risk.js";
import { type ContractRevisionFile } from "../integration/task-integration-evidence.js";
import { type IntegrationRepairTask } from "../integration/create-integration-repair.js";
import { type IntegrationReviewDeps, type IntegrationReviewOutcome } from "../integration/review-integration.js";

export type TerminalTaskBucket = Extract<TaskBucket, "done" | "human-review">;

export type InterruptedTaskBucket = "active" | "delegated" | "error";

/**
 * Kuriuo įrodymu „done" suteiktas be naujo commit'o. Kontrakto savininkas — koordinatorius
 * (`run-coordinator.ts`, VQ-304 2/3); deklaruojama čia, kad `verify-task.ts` ir `skip-dispatch.ts`
 * nepriklausytų nuo dar nemigravusio failo.
 */
export type AlreadyImplementedVia = "marker" | "clean-tree" | "skip-dispatch";

/**
 * Sprendimo įrašo (decision.json) laukai, kurių reikia vykdymo sekai. Struktūriškai
 * suderinamas su etalono `RetryDecision` — application sluoksnis neįgyja importo į
 * infrastruktūrinę schemą, o adapteris perduoda tą patį objektą be konversijos.
 */
export type TaskDecision = {
  verdict?: string;
  selected_model?: string;
  reason?: string;
  child_tasks?: { title?: string; claude_task?: string }[];
};

export type DecisionReadResult = { status: "ok"; decision: TaskDecision } | { status: "invalid" };

export type JsonReadResult<T> = { status: "ok"; value: T } | { status: "corrupted"; error: string };

export type StopStatusSnapshot = { status?: string; task_id?: string };

export type ResumeStateSnapshot = { task_id?: string; phase?: string; status?: string };

export type RunCheckpoint = {
  actor: "supervisor";
  phase: string;
  status: "started" | "waiting" | "finished" | "failed";
  task_id: string;
  task_file: string;
  log_file: string;
  exit_code?: number;
  next_action: string;
};

export type ChildTaskEnqueueResult =
  | { ok: true }
  | { ok: false; invalid: { title?: string; missingSections: string[] }[] }
  | { ok: false; depth_exceeded: { parent_depth: number; max_depth: number } };

export type LogPort = {
  /** Viena eilutė į orchestratoriaus log'ą (etalone — `AG/logs/orchestrator.log`). */
  write(message: string): Promise<void>;
};

export type CliPort = {
  run(args: string[]): Promise<number>;
  runCaptured(args: string[]): Promise<{ code: number; output: string }>;
};

export type FailurePort = {
  isInfrastructureExit(code: number): boolean;
  /** exit != 0 IR (infrastruktūros exit kodas ARBA claude-last.log spawn/ENOENT požymis). */
  isDispatchInfrastructureFailure(exitCode: number, taskId: string): Promise<boolean>;
  /** Konstruoja tikrą `WorkflowInfrastructureError` — `instanceof` yra CLI sluoksnio kontraktas. */
  infrastructureError(
    message: string,
    options: { taskReturnedToQueue: boolean; taskPreservedForResume?: boolean; exitCode: number },
  ): Error;
};

export type TaskFilePort = {
  bucketPath(bucket: TaskBucket, taskName: string): string;
  /** Bucket vardas iš failo kelio (tėvinio katalogo bazinis vardas). */
  bucketOf(filePath: string): string;
  taskIdOf(filePath: string): string;
  exists(filePath: string): Promise<boolean>;
  fingerprint(filePath: string): Promise<string>;
  move(from: string, to: TaskBucket, taskName: string, options?: { updateCurrent?: boolean }): Promise<string>;
  finish(from: string, to: TerminalTaskBucket, taskName: string, cleanupFiles: string[]): Promise<string>;
  activateQueued(queuedFile: string, taskId: string): Promise<string>;
  /** `vq/supervisor/reformulated-task.md` -> task failas. */
  installReformulatedTask(targetFile: string): Promise<void>;
  /** Repair prompt tampa task'o kūnu. */
  writeTaskBody(taskFile: string, content: string): Promise<void>;
  /**
   * `writeTaskBody` atvirkštinė operacija (etalono task 0058): tekstas, kurį repair kelias
   * išsaugo prieš perrašymą, kad vetuotas dispatch'as galėtų grąžinti originalią užduotį.
   */
  readTaskBody(taskFile: string): Promise<string>;
};

export type RepairPromptPort = {
  read(taskId: string): Promise<string>;
  remove(taskId: string): Promise<void>;
};

export type TaskLedgerPort = {
  init(): Promise<void>;
  seenBefore(taskId: string, fingerprint: string): Promise<boolean>;
  recordState(taskId: string, taskName: string, state: string, file: string, fingerprint: string): Promise<void>;
  clearEntry(taskId: string): Promise<void>;
};

export type TaskJournalPort = {
  /**
   * `detail` (etalono task 1204) yra laisvo formato įrodymo eilutė, kuri NEDALYVAUJA
   * statistikoje: learning emiterio `failureSignature` normalizuoja būtent `reason` ir kerpa jį
   * iki 80 simbolių, tad įdėjus turinio hash'ą į `reason` kiekvienas task'as gautų unikalų
   * failure_pattern parašą ir parkų statistika subyrėtų. Todėl hash + ts keliauja į `detail`.
   */
  recordEvent(event: {
    task_id: string;
    to_state: string;
    reason: string;
    phase?: string;
    exit_code?: number;
    detail?: string;
  }): Promise<void>;
  recordPhaseFailure(taskId: string, phase: string, exitCode: number, output: string): Promise<void>;
  recordCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
};

export type RuntimeStatePort = {
  /**
   * `vq/supervisor/decision.json` skaitymas per bendrą schemos validaciją. Nevalidus
   * įrašas (sintaksė arba forma) loguoja WARNING adapteryje ir grąžina `invalid` —
   * kvietėjas parkuoja task'ą į human-review, o ne tyliai naudoja default reikšmes.
   *
   * SVARBU: skaitymas NEcache'inamas. Kanoniniame pass'e `decision.json` skaitomas tris
   * kartus (preflight verdiktas, delegate žingsnis, dispatch), nes jį tarp skaitymų
   * perrašo preflight/diagnozės CLI. Skaitymų skaičius yra elgesio dalis.
   */
  readDecision(taskId: string): Promise<DecisionReadResult>;
  readStopStatus(): Promise<JsonReadResult<StopStatusSnapshot>>;
  readResumeState(taskId: string): Promise<JsonReadResult<ResumeStateSnapshot>>;
  setCurrentTask(taskId: string, taskFile: string): Promise<void>;
  /**
   * Per-task session-writes ledger'io startas + `task-start-status.json` baseline.
   *
   * Etalono task 1209: adapteris rašo ATTEMPT-FIRST — tas pats baseline payload'as pirma
   * keliauja į einamojo attempt'o namespace'ą, ir tik po to tuo pačiu formatu į global failą.
   * Attempt rašymas yra best-effort (runtime artefaktai gali būti išjungti arba jų iš viso
   * nebūti), tad jo nesėkmė virsta WARNING'u ir global-only degradacija, o ne klaida
   * kvietėjui. Global rašymas lieka BESĄLYGINIS, nes global failas tebėra vienintelis
   * baseline šaltinis stop, staging ir rollback skaitytojams; jo rašymo klaida kyla į viršų.
   */
  recordTaskStartStatus(taskId: string): Promise<void>;
  readClaudeLog(taskId: string): Promise<string>;
  logPath(name: "orchestrator.log" | "claude-last.log" | "commit.log"): string;
};

export type GitPort = {
  isRepository(): Promise<boolean>;
  head(): Promise<string | undefined>;
  hasNewHeadSince(ref: string | undefined): Promise<boolean>;
  changedProductPathsSince(ref: string): Promise<string[]>;
  /** Ne-runtime („produkto") purvinų įrašų skaičius iš `git status`. */
  productDirtyCount(): Promise<number>;
  /** Ne-git projektų pakaitalas: `logs/changes.log` + git status sąjunga. */
  recordedChangeCount(): Promise<number>;
  /**
   * Šį task'ą žyminčio commit'o sha branch istorijoje, arba `undefined`, kai tokio nėra
   * (etalono task 890 work evidence; ta pati `taskWorkEvidenceGrepArgs` konvencija ir tas
   * pats task-start baseline intervalas).
   *
   * Grąžinamas sha, o ne `boolean`, nes to paties įrodymo reikia dviem vartams: clean-tree
   * diagnozei (`verify-task.ts`, jai užtenka fakto) ir pre-dispatch praleidimui
   * (`skip-dispatch.ts`, jam commit'as keliauja į log ir žurnalo įrašą). Vienas port'o metodas
   * = viena git užklausa = viena įrodymo konvencija.
   */
  committedWorkShaFor(taskId: string): Promise<string | undefined>;
  /**
   * Kaip `committedWorkShaFor`, bet grąžinamas tik commit'as, kurio diff'e YRA produkto kelių
   * (etalono task 1187). Tvarkomieji commit'ai (`chore(AG/tasks): …`) task'o numerį mini vien
   * dėl bucket perkėlimo; po dispatch'o toks match'as nekaltas, o pre-dispatch vartuose jis
   * vienas uždarytų niekada nedirbtą task'ą. Griežtesnis įrodymas gyvena atskirai, kad
   * `verify-task.ts` clean-tree elgesys liktų baitas-į-baitą nepakitęs.
   */
  committedProductWorkShaFor(taskId: string): Promise<string | undefined>;
};

export type ExecutionPolicyPort = {
  /** Meta klaidą, kai context-pack nepavyksta — klasifikaciją atlieka `dispatch-task.ts`. */
  buildContextPack(promptFile: string): Promise<Record<string, unknown>>;
  enforceBudget(request: {
    model: string;
    contextPack: Record<string, unknown>;
    taskId: string;
    phase: "implementation" | "repair";
  }): Promise<{ ok: boolean; reasons: string[] }>;
  /** Meta klaidą, kai task'o `## Agentai` rolė neleidžia claude adapterio. */
  assertLoopAdapterAllowed(promptFile: string): Promise<void>;
  /** Best-effort whole-task token ledger eilutė; niekada nemeta. */
  logTaskUsageLedger(taskId: string): Promise<void>;
};

/** Grynos diagnozės taisyklės (`domain/diagnosis/dispositions.ts` + stream-log skaitytojas) per port'ą. */
export type DiagnosisRulesPort = {
  hasAlreadyImplementedMarker(claudeLog: string): boolean;
  resolveNoCommitDisposition(inputs: {
    hasAlreadyImplementedMarker: boolean;
    productDirtyCount: number;
    hasWorkEvidence: boolean;
  }): "done" | "rollback" | "human-review";
};

export type CompletionPort = {
  markStable(): Promise<void>;
  /** Architektūros mazgo užbaigimo sinchronizacija; best-effort, loguoja adapteryje. */
  syncArchitectureCompletion(taskId: string, doneTaskFile: string): Promise<void>;
  /** RT-07 priklausomybių kaskada; best-effort, niekada nemeta. */
  cascadeBlockedDependents(taskId: string): Promise<void>;
  /**
   * Etalono task 0029: uždaromo task'o auto-OpenSpec change archyvavimas. Best-effort ir
   * NEPRIVALOMAS (esami testų `completion` literalai jo neturi); adapteris niekada nemeta,
   * done verdiktas nuo jo baigties nepriklauso.
   */
  archiveAutoOpenSpecChange?(taskId: string, doneTaskFile: string): Promise<void>;
  enqueueChildTasks(taskId: string, decision: TaskDecision): Promise<ChildTaskEnqueueResult>;
};

/**
 * IVER-3 integracijos peržiūros efektai: semantinis reviewer'is, `integration-review` fazės
 * biudžeto vartai, usage apskaita ir siauro repair prompt'o persistavimas.
 *
 * Port'as yra NEPRIVALOMAS sąmoningai. Jo nebuvimas reiškia „tik deterministinė integracija":
 * `routine` rizika praeina, o `review-required` parkuojama į human-review — semantinis
 * kvietimas be reviewer'io niekada nevirsta tyliu patvirtinimu. Todėl kompozicijos šaknis
 * (E5) lieka nepakeista: nauja integracijos logika į senąjį workflow'ą nepatenka.
 */
export type IntegrationPort = IntegrationReviewDeps & {
  /** Įrašo integracijos repair prompt'ą, kurį pasiima retry-bounded repair ciklas. */
  writeRepairPrompt?(taskId: string, body: string): Promise<void>;
};

/**
 * Etalono task 0045 — deterministinių integracijos vartų efektai kanoniniame kelyje.
 *
 * `IntegrationPort` (aukščiau) yra SEMANTINĖ peržiūra; šis port'as yra tai, ko reikia, kad
 * vartai apskritai turėtų ką vertinti: vykdymo režimas iš `vq/config/integration-verifier.json`
 * ir kontraktų turinys dviejose revizijose. Abu efektai yra už application sluoksnio ribų
 * (FS ir git), todėl juos paduoda composition root.
 *
 * Port'as NEPRIVALOMAS: jo nebuvimas reiškia „integracijos vartai neprijungti", ir done kelias
 * lieka baitas-į-baitą toks pat, koks buvo iki jo atsiradimo.
 */
export type IntegrationGatePort = {
  /**
   * Vykdymo režimas. Meta `PolicyConfigError`, kai konfigas sugadintas — sugedęs policy failas
   * liečia kiekvieną eilės task'ą, tad kvietėjas jį klasifikuoja kaip infrastruktūros gedimą,
   * o ne kaip vieno task'o human-review parką (tas pats sprendimas kaip `dispatch-task.ts`).
   */
  mode(): Promise<IntegrationEnforcementMode>;
  /** Failo būklė ir turinys konkrečioje revizijoje (žr. `ContractRevisionFile` semantiką). */
  readContractFile(ref: string, filePath: string): Promise<ContractRevisionFile>;
};

/** Trys skaitymo baigtys, kaip `GatesMemoReadResult`: „nėra įrašo" ir „įrašas sugadintas" skiriasi. */
export type PreflightFailureMemoReadResult =
  | { readonly status: "hit"; readonly record: PreflightFailureMemoRecord }
  | { readonly status: "absent" }
  | { readonly status: "corrupted"; readonly errors: readonly string[] };

/**
 * Etalono task 1204 — preflight kritimo memo.
 *
 * Port'as NEPRIVALOMAS: be jo elgesys baitas-į-baitą toks pat, koks buvo iki jo atsiradimo
 * (visi esami `TaskRunPorts` fake'ai testuose lieka galiojantys).
 *
 * Adapteris PRIVALO būti totalus — jokia iš trijų operacijų neatmeta Promise'o; I/O klaida
 * virsta `corrupted` / tyliu no-op + WARNING, kad memo niekada nepakeistų task'o baigties.
 */
export type PreflightFailureMemoPort = {
  read(taskId: string): Promise<PreflightFailureMemoReadResult>;
  record(record: PreflightFailureMemoRecord): Promise<void>;
  clear(taskId: string): Promise<void>;
};

// ---------------------------------------------------------------------------
// CHEAP FINISH (etalono task 0000-0-repair-cheap-finish)
//
// Kai vienintelė likusi klaida yra viena mechaninė (typecheck/test) klaida, produkto darbas
// jau egzistuoja, o task'ą stabdo biudžeto lubos arba retry limitas, loop'as gauna VIENĄ
// papildomą, griežtai apribotą dispatch'ą vietoje parkavimo (retry limito atveju — vietoje
// `rollback-stable` + parkavimo, kuris tą darbą sunaikintų).
//
// Sprendimo taisyklės yra GRYNOS ir gyvena `token-governance` (`decideCheapFinish`);
// čia — tik seka ir efektai per port'ą.
// ---------------------------------------------------------------------------

/**
 * Durabli „šis task'as cheap finish jau gavo" žymė (`vq/state/cheap-finish/<task_id>.json`).
 *
 * Loop'as jos NIEKADA netrina: vienas cheap finish per task'ą yra viso mechanizmo saugiklis,
 * o žymė yra vienintelis įrodymas, kuris išgyvena ir proceso restartą, ir requeue.
 */
export type CheapFinishMarker = {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly armed_at: string;
  /** Bandymo numeris (`a<n>`), kuriam cheap finish paruoštas. */
  readonly attempt_sequence: number;
  readonly reason_class: "typecheck" | "test";
  readonly blocked_by: "task-budget" | "phase-budget" | "retry-limit";
  readonly billable_limit: number;
  readonly max_turns: number;
};

/**
 * Cheap finish efektai, kurių application sluoksnis atlikti negali: durabli žymė, retry
 * skaitiklio būklė ir naujo bandymo paruošimas (retry inkrementas, attempt namespace,
 * `decision.json`, biudžeto epocha, vienkartinis env overlay).
 *
 * Port'as NEPRIVALOMAS: jo nebuvimas reiškia „cheap finish neprijungtas", ir kiekvienas
 * kelias lieka baitas-į-baitą toks pat, koks buvo iki jo atsiradimo (visi esami
 * `TaskRunPorts` fake'ai testuose lieka galiojantys).
 */
export type CheapFinishPort = {
  /**
   * Žymės būklė. `armed` be `record` reiškia „žymė yra, bet jos turinys neperskaitomas" —
   * fail-closed: pats failo egzistavimas jau įrodo, kad cheap finish buvo panaudotas.
   */
  read(taskId: string): Promise<{ status: "armed"; record?: CheapFinishMarker } | { status: "absent" }>;
  /** Rašoma PRIEŠ bet kokį dispatch'ą; niekada nemeta (adapteris totalus). */
  arm(record: CheapFinishMarker): Promise<void>;
  /** Ar KITAS repair dispatch'as jau atsimuštų į retry limitą (`evaluateRetryLimit`). */
  retryBudget(taskId: string): Promise<{ count: number; max: number; nextWouldReachLimit: boolean }>;
  /**
   * Naujo bandymo paruošimas: retry skaitiklio inkrementas (be jo attempt id nepasikeistų ir
   * write-once konteksto artefaktų regeneruoti nebūtų galima), attempt namespace, jo
   * `decision.json` su `token_budget_tier` bei vieno laiptelio modeliu, biudžeto epocha ir
   * vienkartinis `AG_EXECUTION_CONTEXT_MODE=required` overlay sekančiam dispatch'ui.
   */
  prepareDispatch(request: {
    taskId: string;
    promptText: string;
    desiredTierStep: 1;
    tokenBudgetTier: "small";
    resetTaskLedger: boolean;
  }): Promise<{ ok: boolean; attemptSequence: number; selectedModel: string; errors: string[] }>;
};

export type TaskRunPorts = {
  log: LogPort;
  cli: CliPort;
  failure: FailurePort;
  tasks: TaskFilePort;
  repairPrompt: RepairPromptPort;
  ledger: TaskLedgerPort;
  journal: TaskJournalPort;
  state: RuntimeStatePort;
  git: GitPort;
  policy: ExecutionPolicyPort;
  rules: DiagnosisRulesPort;
  completion: CompletionPort;
  integration?: IntegrationPort;
  integrationGate?: IntegrationGatePort;
  preflightMemo?: PreflightFailureMemoPort;
  cheapFinish?: CheapFinishPort;
};

/** Vieno task'o bangos integracijos peržiūros užklausa. */
export type IntegrationRunRequest = {
  /** Task failas, kurio integracija tikrinama — juo taikomas terminalinis perėjimas. */
  taskFile: string;
  waveId: string;
  /** Deterministiniai įrodymai: contract diff, bangos vartai, konfliktai, modulių žemėlapis. */
  evidence: EvaluateIntegrationRiskInput;
  /** Task'o priėmimo kriterijai — reviewer prompt'o riba. */
  acceptanceCriteria?: readonly string[];
  /** Tiesiogiai paliesti moduliai; nenurodžius imami iš rizikos apimties. */
  modules?: readonly string[];
  /** Task'o `## Failai` ribos ir tiksliniai testai siauram repair'ui. */
  repairScope?: {
    allowedPaths: readonly string[];
    forbiddenPaths?: readonly string[];
    targetedTests: readonly string[];
    checks?: readonly string[];
  };
  model?: string;
  /**
   * Etalono task 0045 — ką daryti su verdiktu.
   *
   * Numatytoji reikšmė yra `enforce`, nes toks ir buvo vienintelis iki tol egzistavęs elgesys:
   * bangos kelio kvietėjas, kuris režimo nenurodo, gauna tą pačią fail-safe semantiką kaip
   * anksčiau. `advisory` verdiktą apskaičiuoja ir užregistruoja, bet task'o eigos NEKEIČIA:
   * jokio parkavimo, jokio repair prompt'o.
   */
  enforcement?: IntegrationEnforcementMode;
  /**
   * Įrodymų apimties santrauka `task-events` įrašui (`summarizeTaskIntegrationEvidence`).
   * Be jos žurnale liktų verdiktas be apimties, iš kurios jis išvestas.
   */
  evidenceSummary?: string;
};

export type IntegrationRunResult = {
  risk: IntegrationRiskVerdict;
  review: IntegrationReviewOutcome;
  /** Sugeneruotas siauras repair'as; jo nėra, kai repair'as nereikalingas arba neleistinas. */
  repair?: IntegrationRepairTask;
  /** `true`, kai task'as šio kvietimo metu buvo perkeltas į human-review. */
  parked: boolean;
};
