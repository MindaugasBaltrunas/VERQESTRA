import type {
  DashboardData,
  LoopControlData,
  LoopSlotData,
  LoopSlotMode,
  LoopSlotState,
  LoopWorkerId,
  RuntimeProcess,
  UiWavesView,
  WorkerControlData,
  WorkflowBucket,
} from "./types";

export type StatusVariant = "good" | "warning" | "error" | "live" | "neutral";

/**
 * Žinomos būsenos → spalva. Tikslus žemėlapis eina PIRMAS, nes anksčiau čia buvo tik substring
 * regex'ai su dviem klaidomis (2026-08-06 UI auditas):
 *   - `/ok/` be žodžio ribų pagaudavo bet kokį „…ok…" (`revoked`, `broken`) ir dažydavo jį žaliai;
 *   - `/human|pending/` buvo tikrinamas PRIEŠ `/error|fail/`, tad `human-review-failed`
 *     nusidažydavo geltonai, ne raudonai.
 * Realūs workflow verdiktai `retry`/`follow-up`/`escalate` iš viso nepatekdavo į jokią šaką ir
 * likdavo pilki — vartotojas nematydavo, kad jiems reikia dėmesio.
 */
const KNOWN_STATUS_VARIANTS: Record<string, StatusVariant> = {
  live: "live",
  active: "live",
  delegated: "live",
  running: "live",
  done: "good",
  passed: "good",
  ok: "good",
  complete: "good",
  stopped: "neutral",
  none: "neutral",
  queue: "neutral",
  queued: "neutral",
  "human-review": "warning",
  human_review: "warning",
  pending: "warning",
  repair: "warning",
  retry: "warning",
  "follow-up": "warning",
  escalate: "warning",
  warning: "warning",
  warn: "warning",
  unknown: "warning",
  stale: "warning",
  error: "error",
  failed: "error",
  fail: "error",
  rollback: "error",
  blocked: "error",
  duplicate: "error",
};

export function statusVariant(value: string | undefined): StatusVariant {
  if (!value) return "neutral";
  const normalized = value.trim().toLowerCase();
  const exact = KNOWN_STATUS_VARIANTS[normalized];
  if (exact) return exact;

  // Fallback nežinomoms/sudėtinėms reikšmėms. Griežčiausia klasė tikrinama PIRMA, o žodžių
  // ribos neleidžia `revoked` tapti „ok".
  if (/\b(error|failed|fail|rollback|blocked|duplicate)\b/.test(normalized)) return "error";
  if (/\b(human|pending|repair|retry|follow-up|escalate|warning|warn|unknown|stale)\b/.test(normalized)) return "warning";
  if (/\b(live|active|delegated|running)\b/.test(normalized)) return "live";
  if (/\b(done|passed|ok|complete)\b/.test(normalized)) return "good";
  return "neutral";
}

export function sanitizeLogLine(line: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape stripping is intentional
  const withoutAnsi = line.replace(/[\u001b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
  return withoutAnsi.length > 4_000 ? `${withoutAnsi.slice(0, 4_000)}… [sutrumpinta]` : withoutAnsi;
}

export type OverviewMetric = {
  label: string;
  value: string;
  title?: string;
  variant: StatusVariant;
};

/** Gyvų slot'ų task'ai iš valdiklio bloko — vienintelis tiesioginis „kas vykdoma dabar" įrodymas. */
export function liveTaskIds(data: Pick<DashboardData, "loopControl">): string[] {
  return (data.loopControl?.slots ?? [])
    .map((slot) => slot.task_id)
    .filter((taskId): taskId is string => typeof taskId === "string" && taskId !== "");
}

function basenameOf(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Pirminio medžio užduoties žymė. `null`, kai vykdymas gyvas slot'uose: tada užduotis rodoma per
 * slot'ų metrikas (`OverviewPanel`), o žymė aprašo TIK pirminio medžio dispatch'ą — 2026-09-02
 * auditas: worktree bangų metu ji rodė vakarykštį task'ą su svetimo failo bucket'u.
 */
function currentTaskMetric(data: DashboardData, hasLiveSlots: boolean): OverviewMetric | null {
  if (hasLiveSlots) return null;
  if (data.currentTaskState === "conflicting") {
    return {
      label: "Task markers disagree",
      value: `${data.currentTaskId ?? "—"} ≠ ${data.currentTaskFile ? basenameOf(data.currentTaskFile) : "—"}`,
      title: `current-task-id and current-task-file name different tasks. Recorded path: ${data.currentTaskFile ?? "not set"}`,
      variant: "warning",
    };
  }
  const currentTaskIsStale = data.currentTaskState === "stale";
  return {
    label: currentTaskIsStale ? "Stale task state" : "Current task",
    value: data.currentTaskId
      ? `${data.currentTaskId}${data.currentTaskBucket ? ` (${data.currentTaskBucket})` : ""}`
      : "—",
    title: currentTaskIsStale
      ? `State file does not match the workflow. Recorded path: ${data.currentTaskFile ?? "not set"}`
      : data.currentTaskFile ?? undefined,
    variant: currentTaskIsStale ? "warning" : data.currentTaskState === "active" ? "live" : "neutral",
  };
}

export function adaptOverview(data: DashboardData): OverviewMetric[] {
  const stopText = `${data.stopStatus.status ?? "pending"} ${data.stopStatus.reason ?? ""}`.trim();
  const verdict = data.decision.verdict ?? "—";
  const lastUpdate = data.claudeResume.updated_at ?? data.claudeLogUpdatedAt ?? "—";
  const live = liveTaskIds(data);
  const hasLiveSlots = live.length > 0;

  // Įrašo TASK'AS sprendžia, ar signalas kalba apie dabartinį vykdymą. Pirminio medžio
  // artefaktus (stop įrašą, verdiktą, exit kodą) rašo tik pirminio medžio dispatch'as, tad
  // worktree bangų metu jie yra ANKSTESNIO bėgimo įrodymas — 2026-09-02 auditas: „Claude
  // rezultatas: success" ir „Sprendimas: done" buvo vakarykščio task'o, o etiketė to nesakė.
  // Exit kodas savo task'o neneša — jį rašo tas pats epilogas kaip stop įrašą, tad dalijasi jo id.
  const previousRun = (taskId: string | undefined): boolean =>
    hasLiveSlots && (taskId === undefined || !live.includes(taskId));
  const taskTitle = (taskId: string | undefined): string[] => (taskId === undefined ? [] : [`task: ${taskId}`]);
  const titleOf = (parts: string[]): { title?: string } => (parts.length === 0 ? {} : { title: parts.join(" · ") });

  const stopTaskId = data.stopStatus.task_id;
  const stopIsPrevious = previousRun(stopTaskId);
  const decisionIsPrevious = previousRun(data.decision.task_id);
  const resumeIsPrevious = previousRun(data.claudeResume.task_id);

  // Etiketės rašomos ANGLIŠKAI, nes anglų kalba yra vertimų raktų kalba (`t()` verčia jas į LT).
  // Anksčiau čia buvo lietuviški literalai, tad EN režimu vartotojas matydavo lietuviškus
  // pavadinimus — `t()` jų neatpažindavo ir grąžindavo raktą tokį, koks yra (2026-08-06 UI auditas).
  const current = currentTaskMetric(data, hasLiveSlots);
  return [
    ...(current === null ? [] : [current]),
    {
      // Sugadintas įrodymas NĖRA „nėra įrodymo": serveris jį rado, bet perskaityti negalėjo, ir
      // SĄMONINGAI nenusileido prie globalaus veidrodžio. Rodyti tuščią „pending" reikštų paslėpti
      // būtent tą faktą, dėl kurio attempt namespace'as apskritai egzistuoja.
      label: data.stopStatusCorrupted
        ? "Stop status (unreadable)"
        : stopIsPrevious
          ? "Stop status (previous run)"
          : "Stop status",
      value: data.stopStatusCorrupted ? "corrupted" : stopText,
      // Kilmė rodoma, o ne nutylima: `legacy` reiškia, kad įrodymas gali priklausyti KITAM task'ui,
      // ir operatorius turi tai matyti prieš darydamas išvadą.
      ...titleOf([...(data.stopStatusSource === undefined ? [] : [`source: ${data.stopStatusSource}`]), ...taskTitle(stopTaskId)]),
      variant: data.stopStatusCorrupted ? "error" : stopIsPrevious ? "neutral" : statusVariant(data.stopStatus.status),
    },
    {
      label: decisionIsPrevious ? "Decision (previous run)" : "Decision",
      value: verdict,
      ...titleOf(taskTitle(data.decision.task_id)),
      variant: decisionIsPrevious ? "neutral" : statusVariant(verdict),
    },
    {
      label: stopIsPrevious ? "Claude result (previous run)" : "Claude result",
      value:
        data.claudeExit === null
          ? "pending"
          : data.claudeExit === "0"
            ? "success"
            : `error (${data.claudeExit})`,
      ...titleOf(taskTitle(stopTaskId)),
      variant:
        stopIsPrevious || data.claudeExit === null ? "neutral" : data.claudeExit === "0" ? "good" : "error",
    },
    {
      label: resumeIsPrevious ? "Latest activity (previous run)" : "Latest activity",
      value: lastUpdate,
      ...titleOf(taskTitle(data.claudeResume.task_id)),
      variant: "neutral",
    },
    {
      label: "Stable commit",
      value: data.stableRef ? `${data.stableRef.slice(0, 8)}…` : "—",
      title: data.stableRef ?? undefined,
      variant: "neutral",
    },
  ];
}

export type BucketVariant = "good" | "error" | "warning" | "live" | "neutral";

export const bucketDescriptions: Record<string, string> = {
  queue: "Waiting to start",
  active: "Under validation",
  delegated: "Agent is working",
  error: "Recovery in progress",
  failed: "Retries exhausted",
  "human-review": "Requires your attention",
  done: "Completed",
};

export type WorkflowBucketView = {
  name: string;
  tasks: string[];
  variant: BucketVariant;
  description: string;
  isQueue: boolean;
  totalTasks: number;
};

function bucketVariant(name: string): BucketVariant {
  if (name === "done") return "good";
  if (name === "error" || name === "failed") return "error";
  if (name === "human-review") return "warning";
  if (name === "active" || name === "delegated") return "live";
  return "neutral";
}

export function adaptWorkflowBuckets(buckets: WorkflowBucket[]): WorkflowBucketView[] {
  return buckets.map((b) => ({
    name: b.name,
    tasks: b.tasks,
    variant: bucketVariant(b.name),
    description: bucketDescriptions[b.name] ?? "",
    isQueue: b.name === "queue",
    totalTasks: b.totalCount ?? b.tasks.length,
  }));
}

export type RuntimeProcessView = {
  name: string;
  status: "running" | "stopped" | "unknown";
  detail: string;
  variant: StatusVariant;
};

export function adaptRuntime(processes: RuntimeProcess[]): RuntimeProcessView[] {
  return processes.map((p) => ({
    name: p.name,
    status: p.status,
    detail: p.detail ?? (p.pid ? `pid ${p.pid}` : "pid nežinomas"),
    variant: statusVariant(p.status),
  }));
}

export type WorkerRejectionView = { taskId: string; reason: string; detail: string };

export type WorkerControlView = {
  /** Prašomas slot'ų skaičius — tai, ką rodo pats valdiklis. */
  requested: number;
  source: "env" | "state" | "default";
  /** `false` kai reikšmę diktuoja aplinka: tada valdiklis rodomas, bet neveikia. */
  canEdit: boolean;
  /** Serverio kodas, kodėl prašymo failas nepanaudotas; komponentas rodo savo `t(...)` sakinį. */
  invalid?: WorkerControlData["invalid"];
  /** `false` kol nė viena banga dar nesuplanavo pool'o — tada rezultato rodyti nėra iš ko. */
  lastWaveKnown: boolean;
  granted: number;
  grantedOf: number;
  max: number;
  rejected: WorkerRejectionView[];
};

/**
 * Serverio duomenys → valdiklio rodinys. Gryna funkcija: jokio teksto negeneruoja (tekstas gimsta
 * komponente per `t()`), tik normalizuoja skaičius ir pasako, ar valdiklį apskritai galima naudoti.
 *
 * Duomenų nebuvimas (senas UI serveris) traktuojamas kaip „vienas workeris, redaguoti galima" —
 * numatytoji sistemos būsena, ne klaida.
 */
export function adaptWorkerControl(data: WorkerControlData | undefined): WorkerControlView {
  const requested = data?.requested ?? 1;
  const source = data?.source ?? "default";
  const lastWave = data?.lastWave ?? null;
  return {
    requested,
    source,
    canEdit: source !== "env",
    ...(data?.invalid === undefined ? {} : { invalid: data.invalid }),
    lastWaveKnown: lastWave !== null,
    granted: lastWave?.granted ?? 0,
    grantedOf: lastWave?.requested ?? requested,
    // `0` reiškia „nežinoma": tik banga žino savo limitą, o komponentas šio skaičiaus nerodo, kol
    // `lastWaveKnown` yra `false`. Pasirinkimų sąrašas iš `max` NEIŠVEDAMAS — kol bangos nebuvo,
    // `max` yra 0, tad valdiklis liktų be mygtukų.
    max: lastWave?.max ?? 0,
    rejected: (lastWave?.rejected ?? []).map((entry) => ({
      taskId: entry.task_id,
      // `reason` yra pool'o kodas (`legacy-reads`, `missing-lease`, …) — jis NEVERČIAMAS ir
      // nepergrąžinamas į sakinį: būtent tas kodas yra ieškomas log'e ir snapshot'e.
      reason: entry.reason,
      detail: entry.detail ?? "",
    })),
  };
}

export type LoopSlotView = {
  workerId: LoopWorkerId;
  /** Srauto numeris ekrane (1 arba 2) — jis, o ne `w1`, yra tai, ką operatorius mato. */
  index: number;
  desired: LoopSlotMode;
  state: LoopSlotState;
  taskId: string | null;
  attempt: number | null;
  /**
   * `granted` čia jau yra ŠIO srauto vėliava (serveris siunčia bangos išduotų slot'ų skaičių).
   * Be jos neveiklus srautas atrodytų taip pat, kaip operatoriaus sustabdytas.
   */
  lastWave: { waveId: string; granted: boolean; rejectedReason: string | null } | null;
};

export type LoopControlView = {
  /** `false`, kai serveris šio bloko nesiunčia (senas `dist`): rodomi numatytieji srautai. */
  known: boolean;
  loopStatus: "running" | "stopped" | "unknown";
  stopRequested: boolean;
  slots: LoopSlotView[];
  /** Serverio kodas, kodėl valdymo failas nepanaudotas; komponentas rodo savo `t(...)` sakinį. */
  invalid?: LoopControlData["invalid"];
};

const DEFAULT_LOOP_SLOT_IDS: LoopWorkerId[] = ["w1", "w2"];

function defaultLoopSlot(workerId: LoopWorkerId, index: number): LoopSlotView {
  return { workerId, index, desired: "run", state: "idle", taskId: null, attempt: null, lastWave: null };
}

/**
 * `drain` ir `abort` skiriasi TIK rodoma būsena: abiem atvejais vykdomas bandymas užbaigiamas iki
 * galo, nes priverstinis nutraukimas neįgyvendintas. Serveris tą pačią būseną suveda ir savo
 * pusėje, bet vaizdas negali priklausyti nuo to, kuris `dist` atsakė: nesuderinta pora („veikia",
 * nors operatorius jau sustabdė) būtų melas apie būseną.
 */
function loopSlotState(slot: LoopSlotData): LoopSlotState {
  if (slot.state !== "running") return slot.state;
  if (slot.desired === "abort") return "aborting";
  if (slot.desired === "drain") return "draining";
  return "running";
}

/**
 * Serverio duomenys → srautų rodinys. Gryna funkcija: teksto negeneruoja (jis gimsta komponente per
 * `t()`), tik normalizuoja laukus ir paverčia bangos IŠDUOTŲ slot'ų skaičių šio srauto vėliava.
 *
 * Duomenų nebuvimas (senas UI serveris) traktuojamas kaip du veikiantys, nieko nedirbantys srautai —
 * numatytoji sistemos būsena, ne klaida.
 */
export function adaptLoopControl(data: LoopControlData | undefined): LoopControlView {
  const slots = data?.slots?.length
    ? data.slots.map((slot) => ({
        workerId: slot.worker_id,
        index: slot.worker_index,
        desired: slot.desired,
        state: loopSlotState(slot),
        taskId: slot.task_id ?? null,
        attempt: slot.attempt ?? null,
        lastWave: slot.lastWave
          ? {
              waveId: slot.lastWave.wave_id,
              // Banga išduoda slot'us iš eilės, tad `granted` yra riba: 2-as srautas išduotas tik
              // tada, kai išduoti abu.
              granted: slot.worker_index <= slot.lastWave.granted,
              rejectedReason: slot.lastWave.rejected_reason ?? null,
            }
          : null,
      }))
    : DEFAULT_LOOP_SLOT_IDS.map((workerId, index) => defaultLoopSlot(workerId, index + 1));

  return {
    known: data !== undefined,
    loopStatus: data?.loop.status ?? "unknown",
    stopRequested: data?.loop.stopRequested ?? false,
    ...(data?.invalid === undefined ? {} : { invalid: data.invalid }),
    slots,
  };
}

export type InFlightSlot = {
  workerId: string;
  taskId: string;
};

/**
 * `/api/waves` → kas dabar vykdoma (worker→task), pagrindas apžvalgos suvestinei ir Užduočių
 * lentai. `slots` yra tikslesnis įrodymas (turi `state`/`stale`), tad turi pirmenybę; `leases`
 * yra fallback SENAM serveriui, kuris `slots` lauko dar nesiunčia (2026-09 papildymas, žr.
 * `UiWavesView.slots` komentarą prie tipo apibrėžimo).
 */
export function selectInFlightSlots(data: UiWavesView | null | undefined): InFlightSlot[] {
  if (!data) return [];
  if (data.slots !== undefined) {
    return data.slots
      .filter((slot) => slot.state === "running" && !slot.stale)
      .map((slot) => ({ workerId: slot.worker_id, taskId: normalizeTaskId(slot.task_id) }));
  }
  return data.leases.map((lease) => ({ workerId: lease.worker_id, taskId: normalizeTaskId(lease.task_id) }));
}

/** Tas pats kanoninimas kaip kortelių sąraše (`WorkflowBoard#taskIdOf`): kelias ir `.md` nunešami, kad vėliau lygintume su kortele, ne su pilnu keliu. */
function normalizeTaskId(taskId: string): string {
  const base = basenameOf(taskId);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}
