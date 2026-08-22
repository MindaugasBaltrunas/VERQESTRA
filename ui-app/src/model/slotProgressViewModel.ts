import type { LoopControlView, LoopSlotView } from "./dashboardViewModel";
import type {
  AgentActivity,
  AgentStatus,
  LoopSlotMode,
  LoopSlotState,
  LoopWorkerId,
  UiWaveRefillDecision,
  UiWaveSlot,
  UiWaveSlotState,
} from "./types";

/** Kur srautas yra grandinėje. `unknown` yra PILNAVERTĖ būsena, ne klaida — žr. `resolvePhase`. */
export type SlotProgressPhase =
  | "idle" | "waiting" | "preparing" | "preflight"
  | "implementation" | "review" | "diagnosis" | "finishing" | "unknown";

/** Ar gyvas aktyvumo srautas priskiriamas ŠIAM slot'ui. `ambiguous` — priskirti neįmanoma. */
export type SlotLiveness = "attached" | "ambiguous" | "detached" | "unknown" | "offline";

/** 1231 siūlė: kol biudžeto endpoint'o nėra, šie laukai tiesiog neateina ir juostos nerodome. */
export type SlotBudgetInput = { turns?: number; maxTurns?: number; billableTokens?: number; tokenLimit?: number };

/** 1232 siūlė: ETA ateina kaip rėžis su patikimumu, niekada kaip vienas „tikslus" skaičius. */
export type SlotEtaInput = { lowMs: number; highMs: number; confidence: "high" | "medium" | "low"; basedOnSamples?: number };

export type SlotProgressBar =
  | { signal: "none" } | { signal: "indeterminate" }
  | { signal: "budget"; percent: number; level: "normal" | "warning" | "over"; clamped: boolean }
  | { signal: "chain"; percent: number; level: "normal"; done: number; total: number };

export type SlotEtaView =
  | { state: "unavailable"; reason: "no-source" | "not-enough-data" | "unparseable" }
  | { state: "available"; lowMs: number; highMs: number; confidence: "high" | "medium" | "low" };

export type SlotProgressView = {
  workerId: LoopWorkerId;
  index: number;
  taskId: string | null;
  attempt: number | null;
  desired: LoopSlotMode;
  state: LoopSlotState;
  phase: SlotProgressPhase;
  phaseDetail: string | null;
  elapsedMs: number | null;
  progress: SlotProgressBar;
  eta: SlotEtaView;
  worktree: "yes" | "no" | "unknown";
  lease: { known: boolean; status: string | null; stale: boolean; heartbeatAgeMs: number | null; mismatchedTask: boolean };
  lastError: { ts: string; taskId: string; reason: string } | null;
  blocked: { reason: string; detail: string | null } | null;
  liveness: SlotLiveness;
  chain: { agents: string[]; statuses: Record<string, AgentStatus>; currentAgent: string | null } | null;
};

export type SlotProgressInput = {
  now: number;
  loopControl: LoopControlView;
  waveSlots: readonly UiWaveSlot[] | undefined;
  refillDecisions?: readonly UiWaveRefillDecision[];
  activity: AgentActivity | null;
  activityStatus: "connecting" | "live" | "disconnected";
  budgets?: Readonly<Partial<Record<LoopWorkerId, SlotBudgetInput>>>;
  etas?: Readonly<Partial<Record<LoopWorkerId, SlotEtaInput>>>;
};

/** Agentas → fazė. Nežinomas agentas SĄMONINGAI neįtraukiamas: spėti fazę iš vardo reikštų meluoti. */
const AGENT_PHASES: Record<string, SlotProgressPhase> = {
  "readme-guard": "preflight", architect: "preflight", "data-model": "preflight",
  migrator: "preflight", supervisor: "preflight", security: "preflight",
  coder: "implementation", "schedule-domain": "implementation", i18n: "implementation",
  performance: "implementation", documenter: "implementation",
  reviewer: "review", tester: "review",
  debugger: "diagnosis", repairer: "diagnosis", "audit-director": "diagnosis",
};

export function clampPercent(raw: number): { percent: number; clamped: boolean } {
  if (!Number.isFinite(raw)) return { percent: 0, clamped: true };
  return { percent: Math.round(Math.min(100, Math.max(0, raw))), clamped: raw < 0 || raw > 100 };
}

/** Galioja tik pilna pora: dalis be ribos (ir atvirkščiai) nėra progresas, o pusė duomenų. */
function ratioOf(value: number | undefined, limit: number | undefined): number | null {
  if (value === undefined || limit === undefined) return null;
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) return null;
  return value / limit;
}

export function resolveBudgetProgress(budget: SlotBudgetInput | undefined): SlotProgressBar | null {
  if (!budget) return null;
  const ratios = [ratioOf(budget.turns, budget.maxTurns), ratioOf(budget.billableTokens, budget.tokenLimit)]
    .filter((ratio): ratio is number => ratio !== null);
  if (ratios.length === 0) return null;

  const raw = Math.max(...ratios) * 100;
  if (!Number.isFinite(raw)) return null;
  const { percent, clamped } = clampPercent(raw);
  // Riba tikrinama pagal NEAPKARPYTĄ reikšmę: apkarpytas 100 % ir realus 130 % yra skirtingi faktai.
  const level = raw > 100 ? "over" : percent > 80 ? "warning" : "normal";
  return { signal: "budget", percent, level, clamped };
}

export function resolveEta(input: SlotEtaInput | undefined): SlotEtaView {
  if (!input) return { state: "unavailable", reason: "no-source" };
  const { lowMs, highMs } = input;
  if (!Number.isFinite(lowMs) || !Number.isFinite(highMs) || lowMs < 0 || highMs < 0) {
    return { state: "unavailable", reason: "unparseable" };
  }
  if (input.basedOnSamples !== undefined && (!Number.isFinite(input.basedOnSamples) || input.basedOnSamples < 3)) {
    return { state: "unavailable", reason: "not-enough-data" };
  }
  // Apversta pora yra netvarkinga įvestis, o ne klaida — apsukame ir rodome.
  return { state: "available", lowMs: Math.min(lowMs, highMs), highMs: Math.max(lowMs, highMs), confidence: input.confidence };
}

/**
 * Praėjęs laikas iš lease'o. Neigiamas skirtumas reiškia laikrodžių nesutapimą — tada verčiau
 * serverio suskaičiuotas `lease_age_ms`, o jei ir jo nėra, `null`. NIEKADA ne `NaN` ir ne neigiamas.
 */
export function elapsedMsFrom(acquiredAt: string | null, leaseAgeMs: number | null, now: number): number | null {
  if (acquiredAt) {
    const parsed = Date.parse(acquiredAt);
    if (Number.isFinite(parsed) && now - parsed >= 0) return now - parsed;
  }
  if (leaseAgeMs !== null && Number.isFinite(leaseAgeMs) && leaseAgeMs >= 0) return leaseAgeMs;
  return null;
}

export type PhaseArgs = {
  slotState: LoopSlotState;
  desired: LoopSlotMode;
  taskId: string | null;
  /** `null` — bangos sprendimo nėra; `false` — banga šio srauto neišdavė. */
  granted: boolean | null;
  rejectedReason: string | null;
  leaseState: UiWaveSlotState | null;
  currentAgent: string | null;
  attached: boolean;
  claudeStatus: string | null;
};

/** Pirmas atitikimas laimi. Tvarka yra kontraktas: ji skiria „operatorius sustabdė" nuo „banga neišdavė". */
export function resolvePhase(args: PhaseArgs): { phase: SlotProgressPhase; phaseDetail: string | null } {
  if (args.taskId === null) {
    if (args.desired !== "run") return { phase: "idle", phaseDetail: null };
    if (args.granted === false) return { phase: "waiting", phaseDetail: args.rejectedReason };
    return { phase: "idle", phaseDetail: null };
  }
  if (args.attached && args.currentAgent) {
    const mapped = AGENT_PHASES[args.currentAgent];
    return mapped
      ? { phase: mapped, phaseDetail: args.currentAgent }
      : { phase: "unknown", phaseDetail: args.currentAgent };
  }
  if (args.attached && args.claudeStatus) return { phase: "unknown", phaseDetail: args.claudeStatus };
  if (!args.attached && args.leaseState === "provisioned") return { phase: "preparing", phaseDetail: null };
  if (!args.attached && (args.slotState === "draining" || args.slotState === "aborting")) {
    return { phase: "finishing", phaseDetail: null };
  }
  return { phase: "unknown", phaseDetail: null };
}

/**
 * Vienas GLOBALUS `AgentActivity` srautas be `worker_id` — susieti su srautu galima tik per užduotį.
 * Du srautai su ta pačia užduotimi reiškia, kad priskirti NEĮMANOMA: tada grandinės nerodo niekas.
 */
export function correlateActivity(
  activity: AgentActivity | null,
  slots: readonly LoopSlotView[],
): { attachedTo: LoopWorkerId | null; attribution: "attached" | "ambiguous" | "unknown" } {
  if (!activity || activity.taskId === null) return { attachedTo: null, attribution: "unknown" };
  const matches = slots.filter((slot) => slot.taskId !== null && slot.taskId === activity.taskId);
  if (matches.length === 1) return { attachedTo: matches[0].workerId, attribution: "attached" };
  if (matches.length > 1) return { attachedTo: null, attribution: "ambiguous" };
  return { attachedTo: null, attribution: "unknown" };
}

/** Naujausias šio workerio neigiamas papildymo sprendimas: pirma pagal laiką, tik paskui pagal epizodą. */
function newestRejectedRefill(
  decisions: readonly UiWaveRefillDecision[],
  workerId: LoopWorkerId,
): UiWaveRefillDecision | null {
  let best: UiWaveRefillDecision | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const decision of decisions) {
    if (decision.worker_id !== workerId || decision.granted) continue;
    const parsed = Date.parse(decision.decided_at);
    const score = Number.isFinite(parsed) ? parsed : decision.episode;
    if (best === null || score >= bestScore) {
      best = decision;
      bestScore = score;
    }
  }
  return best;
}

function resolveBlocked(
  slot: LoopSlotView,
  decisions: readonly UiWaveRefillDecision[],
): { reason: string; detail: string | null } | null {
  if (slot.lastWave && !slot.lastWave.granted && slot.lastWave.rejectedReason) {
    return { reason: slot.lastWave.rejectedReason, detail: null };
  }
  const refill = newestRejectedRefill(decisions, slot.workerId);
  if (!refill) return null;
  return { reason: refill.reason, detail: refill.hard_capped > 0 ? `hard_capped=${refill.hard_capped}` : null };
}

function chainProgress(agents: string[], statuses: Record<string, AgentStatus>): SlotProgressBar | null {
  if (agents.length === 0) return null;
  // `error` NĖRA `done`: nepavykęs agentas nestumia juostos į priekį.
  const done = agents.filter((agent) => statuses[agent] === "done").length;
  return { signal: "chain", percent: Math.round((done / agents.length) * 100), level: "normal", done, total: agents.length };
}

/**
 * Srautų kortelių rodinys. Bazė — VISADA `loopControl.slots`: bangų lease'as savo eilutės nesukuria,
 * nes lease'as be srauto reikštų slot'ą, kurio valdiklis nepažįsta.
 */
export function buildSlotProgressViews(input: SlotProgressInput): SlotProgressView[] {
  const { attachedTo, attribution } = correlateActivity(input.activity, input.loopControl.slots);
  const disconnected = input.activityStatus === "disconnected";
  const hasLiveTask = input.activity !== null && input.activity.taskId !== null;
  const decisions = input.refillDecisions ?? [];

  return input.loopControl.slots.map((slot) => {
    const waveSlot = input.waveSlots?.find((candidate) => candidate.worker_id === slot.workerId) ?? null;
    // Žinomas „reused-lease" defektas: baigto task'o lease'as apstampuojamas nauju keliu. Tokia
    // pora negali maitinti nei laikmačio, nei darbo kopijos — bet `last_failure` lieka, nes jis
    // neša SAVO `task_id` ir yra faktas.
    const mismatchedTask = waveSlot !== null && slot.taskId !== null && waveSlot.task_id !== slot.taskId;
    const usableLease = waveSlot !== null && !mismatchedTask;

    const attached = !disconnected && attribution === "attached" && attachedTo === slot.workerId;
    const liveness: SlotLiveness = disconnected
      ? "unknown"
      : input.loopControl.loopStatus === "stopped" && slot.taskId === null
        ? "offline"
        : attribution === "ambiguous"
          ? "ambiguous"
          : attached
            ? "attached"
            : attribution === "unknown" && hasLiveTask
              ? "detached"
              : "unknown";

    const chain = attached && input.activity
      ? { agents: input.activity.chain, statuses: input.activity.statuses, currentAgent: input.activity.currentAgent }
      : null;

    const { phase, phaseDetail } = resolvePhase({
      slotState: slot.state,
      desired: slot.desired,
      taskId: slot.taskId,
      granted: slot.lastWave ? slot.lastWave.granted : null,
      rejectedReason: slot.lastWave?.rejectedReason ?? null,
      leaseState: usableLease ? waveSlot.state : null,
      currentAgent: chain?.currentAgent ?? null,
      attached,
      claudeStatus: input.activity?.claudeStatus ?? null,
    });

    const progress =
      resolveBudgetProgress(input.budgets?.[slot.workerId]) ??
      (chain ? chainProgress(chain.agents, chain.statuses) : null) ??
      (slot.taskId !== null && (slot.state === "running" || attached)
        ? ({ signal: "indeterminate" } as SlotProgressBar)
        : ({ signal: "none" } as SlotProgressBar));

    return {
      workerId: slot.workerId,
      index: slot.index,
      taskId: slot.taskId,
      attempt: slot.attempt,
      desired: slot.desired,
      state: slot.state,
      phase,
      phaseDetail,
      elapsedMs: usableLease ? elapsedMsFrom(waveSlot.acquired_at, waveSlot.lease_age_ms, input.now) : null,
      progress,
      eta: resolveEta(input.etas?.[slot.workerId]),
      worktree: usableLease ? (waveSlot.has_worktree ? "yes" : "no") : "unknown",
      lease: {
        known: waveSlot !== null,
        status: waveSlot?.lease_status ?? null,
        stale: waveSlot?.stale ?? false,
        heartbeatAgeMs: waveSlot?.heartbeat_age_ms ?? null,
        mismatchedTask,
      },
      lastError: waveSlot?.last_failure
        ? { ts: waveSlot.last_failure.ts, taskId: waveSlot.last_failure.task_id, reason: waveSlot.last_failure.reason }
        : null,
      blocked: resolveBlocked(slot, decisions),
      liveness,
      chain,
    };
  });
}
