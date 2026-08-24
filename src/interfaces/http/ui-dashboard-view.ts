// `GET /api/dashboard` atsakymas (etalonas: AG_loop interfaces/cli/ui/index.ts
// `loadDashboardData`).
//
// KODĖL ŠIS MODULIS EGZISTUOJA. Iki 2026-08-23 UI paleidimo audito `/api/dashboard` grąžindavo
// `UiControlPlaneData` — vieną iš SAVO blokų, ne visą snapshot'ą. React klientas tą patį atsakymą
// skaito kaip `DashboardData`, tad pirmas adapteris kreipdavosi į `stopStatus.status`, medis
// nulūždavo prieš pirmą renderį, o operatorius matydavo tuščią ekraną. TypeScript `as` cast'as
// abiejuose galuose nėra kontraktas: nė vienas testas jų nesulygino.
//
// Trys taisyklės, kurios yra šio modulio kontraktas:
//
//   1. WIRE FORMA priklauso KLIENTUI. Laukų vardai ir jų privalomumas atkartoja
//      `ui-app/src/model/types.ts#DashboardData`. Šio failo lauko pervadinimas be to failo yra
//      tylus lūžis — būtent toks, kokį uždaro ši migracija.
//   2. VIENO ŠALTINIO LŪŽIS NENUVERČIA DASHBOARD'O, BET IR NENUTYLA. Dashboard'as yra
//      DIAGNOSTIKOS paviršius, į kurį kreipiamasi tada, kai kažkas sulūžę; sugadintas artefaktas
//      virsta įvardytu `degraded` įrašu, o ne 500.
//   3. TIK SKAITYMAS. Nė vienas kelias čia nieko nemutuoja — dashboard'as bandymų nekuria ir
//      vėliavų nesuvartoja (`loop-stop.requested` tikrinamas TIK egzistavimu: jo šalinimas
//      atšauktų operatoriaus „stop" kas 30 s).

import path from "node:path";
import { taskBuckets } from "../../domain/tasks/buckets.js";
import type { LoopControlProblem, LoopControlState } from "../../application/scheduling/loop-control-store.js";
import type { WorkerRequestProblem, WorkerRequestState } from "../../application/scheduling/worker-request-store.js";
import {
  deriveLoopSlots,
  type LoopSlotLeaseView,
  type UiLoopSlot,
} from "../ui-model/loop-slot-model.js";
import { toUiTokenBudget, type UiTokenBudget } from "../ui-model/token-budget-view.js";
import type { UiControlPlaneData } from "../ui-model/control-plane-model.js";
import { loopPidFile, loopStopFile } from "./loop-lifecycle.js";
import type { WorkflowBucketView } from "./workflow-buckets.js";

/** Resume checkpoint'o santrauka; visi laukai optional — failas rašomas palaipsniui. */
export type UiResumeSummary = {
  phase?: string;
  status?: string;
  task_id?: string;
  log_file?: string;
  log_bytes?: number;
  log_lines?: number;
  next_action?: string;
  updated_at?: string;
};

export type UiRuntimeStatus = "running" | "stopped" | "unknown";

export type UiRuntimeProcess = {
  name: string;
  pid?: number;
  status: UiRuntimeStatus;
  detail?: string;
};

/** Proceso būsena BE vardo: vardą prideda vaizdas, tad portas jo nežino. */
export type UiProcessState = { pid?: number | undefined; status: UiRuntimeStatus; detail?: string | undefined };

export type UiStatusFile = {
  name: string;
  present: boolean;
  bytes?: number;
  updatedAt?: string;
};

/** Paskutinės bangos pool'o santrauka taip, kaip ją mato valdiklis. */
export type UiWaveWorkerPool = {
  wave_id: string;
  mode: string;
  requested: number;
  granted: number;
  max: number;
  rejected: readonly { task_id: string; reason: string; detail: string }[];
  slots?: readonly { worker_id: string; task_id: string; attempt: number }[] | undefined;
};

export type UiWorkerControl = {
  requested: number;
  source: WorkerRequestState["source"];
  envOverride: boolean;
  invalid?: WorkerRequestProblem;
  /** `null` kol nė viena banga nesuplanavo pool'o — tada rezultato rodyti nėra iš ko. */
  lastWave: UiWaveWorkerPool | null;
};

export type UiLoopControl = {
  loop: { status: UiRuntimeStatus; stopRequested: boolean };
  slots: UiLoopSlot[];
  invalid?: LoopControlProblem;
};

/**
 * `/api/dashboard` atsakymas. Formos autoritetas — `ui-app/src/model/types.ts#DashboardData`;
 * papildomi laukai (`stopStatusSource`, `degraded`, …) klientui neprivalomi, bet PRIVALOMI
 * laukai privalo sutapti vardas į vardą.
 */
export type UiDashboardData = {
  root: string;
  currentTaskId: string | null;
  currentTaskFile: string | null;
  currentTaskBucket: string | null;
  currentTaskState: "active" | "stale" | "none";
  claudeExit: string | null;
  stableRef: string | null;
  /** PILNAS stop įrašas (`task_id`, `head`, `git_status`, …), o ne `{status, reason}` pjūvis. */
  stopStatus: Record<string, unknown>;
  /** `attempt | legacy | none` — kuris įrodymas priimtas. Kilmė rodoma, o ne nutylima. */
  stopStatusSource: string;
  stopStatusCorrupted: boolean;
  decision: Record<string, unknown>;
  supervisorResume: UiResumeSummary;
  claudeResume: UiResumeSummary;
  runtime: UiRuntimeProcess[];
  claudeLogUpdatedAt: string | null;
  claudeLogBytes: number | null;
  claudeLogSource: string;
  workflowBuckets: WorkflowBucketView[];
  statusFiles: UiStatusFile[];
  /** Praleidžiamas TIK tada, kai šaltinio perskaityti nepavyko — tada jis yra `degraded` sąraše. */
  controlPlane?: UiControlPlaneData;
  workerControl: UiWorkerControl;
  loopControl: UiLoopControl;
  /** Šaltiniai, kurių nepavyko perskaityti. Tuščias sąrašas reiškia „viskas perskaityta". */
  degraded: string[];
};

/** Bangos snapshot'o pjūvis, kurio reikia dashboard'ui — struktūrinis, be loop sluoksnio importo. */
export type DashboardWaveSnapshot = {
  worker_pool?: UiWaveWorkerPool | undefined;
  tasks?: readonly { task_id: string; state: string }[] | undefined;
  /**
   * Vykdymo AUTORITETAS `deriveLoopSlots`ui. `started_at`/`worktree_path` čia SĄMONINGAI nėra:
   * pirmojo niekas nerodo (praėjęs laikas skaičiuojamas iš lease'o), o antrasis yra absoliutus
   * kelias, kurio `ui-waves-view` taisyklė į naršyklę neišleidžia.
   */
  live_slots?: readonly { worker_id: string; task_id: string; attempt: number }[] | undefined;
};

export type DashboardStopEvidence = {
  record: Record<string, unknown>;
  origin: string;
  corrupted: boolean;
};

export type DashboardFileStamp = { updatedAt?: string | undefined; bytes?: number | undefined };

export type DashboardClaudeLogStamp = DashboardFileStamp & { source: string };

export type DashboardViewPorts = {
  /** Runtime katalogų garantija — vienintelis šio kelio šalutinis efektas (jis idempotentinis). */
  ensureDirs(): Promise<void>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  fileExists(absolutePath: string): Promise<boolean>;
  /** Failo antspaudas; nesamas failas — tuščias objektas (ne klaida). */
  fileStamp(absolutePath: string): Promise<DashboardFileStamp>;
  loadWorkflowBuckets(): Promise<WorkflowBucketView[]>;
  loadControlPlane(): Promise<UiControlPlaneData>;
  readWorkerRequest(): Promise<WorkerRequestState>;
  readLoopControl(): Promise<LoopControlState>;
  /** Snapshot'as arba `undefined`; sugadintas failas irgi `undefined` („plano dar nėra"). */
  readWaveSnapshot(): Promise<DashboardWaveSnapshot | undefined>;
  listWorkerLeases(): Promise<readonly LoopSlotLeaseView[]>;
  /** Attempt-first stop įrodymas; tuščias taskId — įrodymo nėra. */
  readStopEvidence(taskId: string): Promise<DashboardStopEvidence>;
  /** Claude sesijos log'o antspaudas attempt-first; kilmė grąžinama atskirai. */
  readClaudeLogStamp(taskId: string): Promise<DashboardClaudeLogStamp>;
  /**
   * Proceso būsena iš PID/runtime įrašo. `selfRegistering` — ar procesas PATS registruoja ir valo
   * savo įrašą (loop'as): tada įrašo nebuvimas reiškia „sustojęs", o ne „nežinia".
   */
  inspectProcess(pidFile: string, options: { selfRegistering: boolean }): Promise<UiProcessState>;
  /** Šio UI proceso PID — vienintelis runtime faktas, kurio nereikia skaityti iš disko. */
  uiProcessPid(): number;
  logError?(message: string): void;
};

export type BuildDashboardViewInput = {
  ports: DashboardViewPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  /** AG šaknis (`<root>/AG`) — eilės bucket'ai. */
  agRoot?: string;
};

/**
 * Būsenos failų sveikatos eilutė: vardas, ar failas yra, jo dydis ir mtime.
 *
 * `token-budget-status.json` čia LIEKA (metaduomenys atsako „ar biudžeto vartai apskritai kada
 * nors rašė"), bet jo TURINYS keliauja atskirai — žr. `controlPlane.token_budget`: vien mtime
 * neatsako nei kokios lubos galioja, nei kiek jų sudeginta.
 */
const STATUS_FILE_NAMES = [
  "current-task-id",
  "current-task-file",
  "quality-gates-status.json",
  "token-budget-status.json",
  "claude-stop-status.json",
  "supervisor-resume.json",
  "claude-resume.json",
] as const;

/** Pasyvus indikatorius be rašytojo gyvavimo ciklo — nebuvimas jam nieko neįrodo. */
const USER_CLAUDE_PID_FILE = "user-claude.pid";

const UNKNOWN_PROCESS: UiProcessState = { status: "unknown" };
const DEFAULT_WORKER_REQUEST: WorkerRequestState = { requested: 1, source: "default", envOverride: false };
const NO_STOP_EVIDENCE: DashboardStopEvidence = { record: {}, origin: "none", corrupted: false };
const NO_CLAUDE_LOG: DashboardClaudeLogStamp = { source: "none" };

function parseJsonRecord(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Vieno šaltinio skaitymas: nesėkmė virsta fallback reikšme ir įrašu `degraded` sąraše. */
async function readSource<T>(
  ports: DashboardViewPorts,
  name: string,
  fallback: T,
  read: () => Promise<T>,
  degraded: string[],
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    ports.logError?.(
      `[ui] dashboard source '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    degraded.push(name);
    return fallback;
  }
}

/** Tuščia eilutė ir nesamas failas yra ta pati būsena — `null`, ne `""`. */
function textOrNull(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

async function locateCurrentTaskBucket(
  ports: DashboardViewPorts,
  agRoot: string,
  currentTaskId: string | null,
  currentTaskFile: string | null,
): Promise<string | null> {
  const fileName = currentTaskFile ? path.basename(currentTaskFile) : currentTaskId ? `${currentTaskId}.md` : null;
  if (fileName === null) return null;

  for (const bucket of taskBuckets) {
    if (await ports.fileExists(path.join(agRoot, "tasks", bucket, fileName))) return bucket;
  }
  return null;
}

async function readStatusFiles(ports: DashboardViewPorts, stateDir: string): Promise<UiStatusFile[]> {
  return await Promise.all(
    STATUS_FILE_NAMES.map(async (name): Promise<UiStatusFile> => {
      const stamp = await ports.fileStamp(path.join(stateDir, name));
      return {
        name,
        present: stamp.bytes !== undefined,
        ...(stamp.bytes === undefined ? {} : { bytes: stamp.bytes }),
        ...(stamp.updatedAt === undefined ? {} : { updatedAt: stamp.updatedAt }),
      };
    }),
  );
}

/**
 * Visas dashboard snapshot'as vienu skaitymu.
 *
 * Nepriklausomi skaitymai eina LYGIAGREČIAI: šis maršrutas kviečiamas kas 30 s kiekvienam
 * atidarytam tab'ui, o nuosekli grandinė laukė kiekvieno ankstesnio be jokios priežasties.
 */
export async function buildDashboardView(input: BuildDashboardViewInput): Promise<UiDashboardData> {
  const ports = input.ports;
  const root = path.resolve(input.projectRoot);
  const runtimeRoot = input.runtimeRoot ?? path.join(root, "vq");
  const agRoot = input.agRoot ?? path.join(root, "AG");
  const stateDir = path.join(runtimeRoot, "state");
  const statePath = (name: string): string => path.join(stateDir, name);
  const degraded: string[] = [];
  const text = (name: string, file: string): Promise<string | undefined> =>
    readSource<string | undefined>(ports, name, undefined, () => ports.readTextFileIfExists(file), degraded);

  await readSource<void>(ports, "runtime_dirs", undefined, () => ports.ensureDirs(), degraded);

  const [
    currentTaskId,
    currentTaskFile,
    claudeExit,
    stableRef,
    decisionRaw,
    supervisorResumeRaw,
    claudeResumeRaw,
    tokenBudgetRaw,
    workflowBuckets,
    statusFiles,
    controlPlane,
    workerRequest,
    waveSnapshot,
    loopControl,
    loopStopRequested,
    loopRuntime,
    userClaudeRuntime,
  ] = await Promise.all([
    text("current_task_id", statePath("current-task-id")),
    text("current_task_file", statePath("current-task-file")),
    text("claude_exit", statePath("claude-last-exit-code")),
    text("stable_ref", statePath("stable-ref")),
    text("decision", path.join(runtimeRoot, "supervisor", "decision.json")),
    text("supervisor_resume", statePath("supervisor-resume.json")),
    text("claude_resume", statePath("claude-resume.json")),
    text("token_budget", statePath("token-budget-status.json")),
    readSource<WorkflowBucketView[]>(ports, "workflow_buckets", [], () => ports.loadWorkflowBuckets(), degraded),
    readSource<UiStatusFile[]>(ports, "status_files", [], () => readStatusFiles(ports, stateDir), degraded),
    readSource<UiControlPlaneData | undefined>(ports, "control_plane", undefined, () => ports.loadControlPlane(), degraded),
    readSource<WorkerRequestState>(ports, "worker_request", DEFAULT_WORKER_REQUEST, () => ports.readWorkerRequest(), degraded),
    readSource<DashboardWaveSnapshot | undefined>(ports, "wave_snapshot", undefined, () => ports.readWaveSnapshot(), degraded),
    readSource<LoopControlState | undefined>(ports, "loop_control", undefined, () => ports.readLoopControl(), degraded),
    // Stop vėliava tikrinama TIK skaitymu: jos suvartojimas atšauktų operatoriaus „stop".
    readSource<boolean>(ports, "loop_stop_flag", false, () => ports.fileExists(loopStopFile(stateDir)), degraded),
    readSource<UiProcessState>(ports, "loop_runtime", UNKNOWN_PROCESS, () => ports.inspectProcess(loopPidFile(stateDir), { selfRegistering: true }), degraded),
    readSource<UiProcessState>(ports, "user_claude_runtime", UNKNOWN_PROCESS, () => ports.inspectProcess(statePath(USER_CLAUDE_PID_FILE), { selfRegistering: false }), degraded),
  ]);

  const taskId = textOrNull(currentTaskId);
  const taskFile = textOrNull(currentTaskFile);

  // Antras, mažas lygiagretus batch'as: stop įrodymas, log'o antspaudas ir bucket'o paieška
  // priklauso nuo einamojo task'o, tad su pirmuoju eiti negalėjo.
  const [stopEvidence, claudeLogStamp, currentTaskBucket] = await Promise.all([
    readSource<DashboardStopEvidence>(ports, "stop_evidence", NO_STOP_EVIDENCE, () => ports.readStopEvidence(taskId ?? ""), degraded),
    readSource<DashboardClaudeLogStamp>(ports, "claude_log", NO_CLAUDE_LOG, () => ports.readClaudeLogStamp(taskId ?? ""), degraded),
    readSource<string | null>(ports, "current_task_bucket", null, () => locateCurrentTaskBucket(ports, agRoot, taskId, taskFile), degraded),
  ]);

  const tokenBudget: UiTokenBudget | undefined = toUiTokenBudget(parseJsonRecord(tokenBudgetRaw));

  // `controlPlane` praleidžiamas TIK tada, kai jo perskaityti nepavyko: klientui `undefined`
  // reiškia „duomenų nėra", o tuščias blokas melagingai reikštų „nieko nelaukia".
  const controlPlaneView: UiControlPlaneData | undefined =
    controlPlane === undefined
      ? undefined
      : {
          ...controlPlane,
          ...(tokenBudget === undefined ? {} : { token_budget: tokenBudget }),
        };

  // Lease'ai skaitomi TIK kaip atsarginis kelias: kai snapshot'ą rašė senesnis `dist`, slot'ų
  // jame nėra. Sugadintas lease store negali nuversti dashboard'o.
  const leases: readonly LoopSlotLeaseView[] =
    (waveSnapshot?.worker_pool?.slots?.length ?? 0) > 0
      ? []
      : await readSource<readonly LoopSlotLeaseView[]>(ports, "worker_leases", [], () => ports.listWorkerLeases(), degraded);

  const currentTaskState: UiDashboardData["currentTaskState"] =
    taskId === null && taskFile === null
      ? "none"
      : currentTaskBucket === "active" || currentTaskBucket === "delegated"
        ? "active"
        : "stale";

  return {
    root,
    currentTaskId: taskId,
    currentTaskFile: taskFile,
    currentTaskBucket,
    currentTaskState,
    claudeExit: textOrNull(claudeExit),
    stableRef: textOrNull(stableRef),
    stopStatus: stopEvidence.record,
    stopStatusSource: stopEvidence.origin,
    stopStatusCorrupted: stopEvidence.corrupted,
    decision: parseJsonRecord(decisionRaw),
    supervisorResume: parseJsonRecord(supervisorResumeRaw),
    claudeResume: parseJsonRecord(claudeResumeRaw),
    runtime: [
      { name: "AG UI", pid: ports.uiProcessPid(), status: "running" },
      toRuntimeProcess("AG loop", loopRuntime),
      toRuntimeProcess("User Claude terminal", userClaudeRuntime),
    ],
    claudeLogUpdatedAt: claudeLogStamp.updatedAt ?? null,
    claudeLogBytes: claudeLogStamp.bytes ?? null,
    claudeLogSource: claudeLogStamp.source,
    workflowBuckets,
    // `queueCounts` PAŠALINTAS 2026-08-24: jis buvo `workflowBuckets[].totalCount` perrašymas kitu
    // raktu, ir klientas jo neskaitė — jis skaito patį `totalCount`. Du to paties skaičiaus
    // pavidalai viename atsakyme anksčiau ar vėliau prasilenkia, o tada ekranas turi du atsakymus
    // į vieną klausimą.
    statusFiles,
    ...(controlPlaneView === undefined ? {} : { controlPlane: controlPlaneView }),
    workerControl: {
      // Prašymas ir paskutinis jo REZULTATAS keliauja kartu: be pool'o santraukos operatorius
      // matytų „prašoma 2" ir manytų, kad du workeriai dirba, nors banga antrą slot'ą atmetė.
      requested: workerRequest.requested,
      source: workerRequest.source,
      envOverride: workerRequest.envOverride,
      ...(workerRequest.invalid === undefined ? {} : { invalid: workerRequest.invalid }),
      lastWave: waveSnapshot?.worker_pool ?? null,
    },
    loopControl: {
      // Norimą būseną rašo operatorius (`loop-control.json`), realią įrodo bangos snapshot'as —
      // jos laikomos atskirai, kad UI galėtų parodyti ir „stabdoma, bet dar dirba".
      loop: { status: loopRuntime.status, stopRequested: loopStopRequested },
      slots:
        loopControl === undefined
          ? []
          : deriveLoopSlots({
              control: loopControl,
              ...(waveSnapshot === undefined ? {} : { snapshot: waveSnapshot }),
              leases,
            }),
      ...(loopControl?.invalid === undefined ? {} : { invalid: loopControl.invalid }),
    },
    degraded,
  };
}

function toRuntimeProcess(name: string, state: UiProcessState): UiRuntimeProcess {
  return {
    name,
    ...(state.pid === undefined ? {} : { pid: state.pid }),
    status: state.status,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
  };
}
