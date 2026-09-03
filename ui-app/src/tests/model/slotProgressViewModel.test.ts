import { describe, expect, it } from "vitest";
import type { LoopControlView, LoopSlotView } from "../../model/dashboardViewModel";
import type { AgentActivity, UiWaveRefillDecision, UiWaveSlot } from "../../model/types";
import {
  buildSlotProgressViews,
  clampPercent,
  correlateActivity,
  elapsedMsFrom,
  resolveBudgetProgress,
  resolveEta,
  resolvePhase,
  type PhaseArgs,
  type SlotProgressInput,
} from "../../model/slotProgressViewModel";

const NOW = Date.parse("2026-08-15T06:04:00.000Z");
const ACQUIRED_AT = "2026-08-15T06:00:00.000Z";

function slot(overrides: Partial<LoopSlotView> = {}): LoopSlotView {
  return {
    workerId: "w1",
    index: 1,
    desired: "run",
    state: "idle",
    taskId: null,
    attempt: null,
    lastWave: null,
    ...overrides,
  };
}

function control(slots: LoopSlotView[], overrides: Partial<LoopControlView> = {}): LoopControlView {
  return { known: true, loopStatus: "running", stopRequested: false, slots, ...overrides };
}

function waveSlot(overrides: Partial<UiWaveSlot> = {}): UiWaveSlot {
  return {
    worker_id: "w1",
    task_id: "1233-a",
    state: "running",
    lease_status: "held",
    acquired_at: ACQUIRED_AT,
    heartbeat_at: "2026-08-15T06:03:55.000Z",
    expires_at: "2026-08-15T06:10:00.000Z",
    lease_age_ms: 240_000,
    heartbeat_age_ms: 5_000,
    stale: false,
    has_worktree: true,
    last_failure: null,
    ...overrides,
  };
}

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    chain: [],
    statuses: {},
    currentAgent: null,
    currentActivity: null,
    taskId: null,
    claudeStatus: null,
    mode: "idle",
    updatedAt: "2026-08-15T06:04:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<SlotProgressInput> = {}): SlotProgressInput {
  return {
    now: NOW,
    loopControl: control([slot()]),
    waveSlots: undefined,
    activity: null,
    activityStatus: "live",
    ...overrides,
  };
}

describe("clampPercent", () => {
  it("keeps a value inside 0–100 and reports when it had to be cut", () => {
    expect(clampPercent(-5)).toEqual({ percent: 0, clamped: true });
    expect(clampPercent(0)).toEqual({ percent: 0, clamped: false });
    expect(clampPercent(100)).toEqual({ percent: 100, clamped: false });
    expect(clampPercent(142)).toEqual({ percent: 100, clamped: true });
  });

  it("never lets a non-finite input reach the screen as NaN", () => {
    expect(clampPercent(Number.NaN)).toEqual({ percent: 0, clamped: true });
    expect(clampPercent(Number.POSITIVE_INFINITY)).toEqual({ percent: 0, clamped: true });
  });
});

describe("resolveBudgetProgress", () => {
  it("treats a missing, zero or half-known limit as no budget at all", () => {
    expect(resolveBudgetProgress(undefined)).toBeNull();
    // Nulinė riba: dalyba iš nulio niekada nevirsta juosta.
    expect(resolveBudgetProgress({ turns: 5, maxTurns: 0 })).toBeNull();
    // Reikšmė be savo ribos yra pusė duomenų, o ne 0 %.
    expect(resolveBudgetProgress({ turns: 5 })).toBeNull();
    expect(resolveBudgetProgress({ maxTurns: 80 })).toBeNull();
    expect(resolveBudgetProgress({ billableTokens: 1_000 })).toBeNull();
  });

  it("shows the tighter of the two budgets", () => {
    // Token'ai išnaudoti 90 %, turn'ai — 25 %: rodoma tai, kas realiai baigsis pirmiau.
    expect(resolveBudgetProgress({ turns: 20, maxTurns: 80, billableTokens: 900, tokenLimit: 1_000 })).toEqual({
      signal: "budget",
      percent: 90,
      level: "warning",
      clamped: false,
    });
  });

  it("warns strictly above 80 %, so exactly 80 % is still normal", () => {
    expect(resolveBudgetProgress({ turns: 80, maxTurns: 100 })).toEqual({
      signal: "budget",
      percent: 80,
      level: "normal",
      clamped: false,
    });
    expect(resolveBudgetProgress({ turns: 81, maxTurns: 100 })).toEqual({
      signal: "budget",
      percent: 81,
      level: "warning",
      clamped: false,
    });
  });

  it("reports going over the limit as an over-budget fact, not as a full bar", () => {
    expect(resolveBudgetProgress({ turns: 130, maxTurns: 100 })).toEqual({
      signal: "budget",
      percent: 100,
      level: "over",
      clamped: true,
    });
  });

  it("ignores non-finite numbers instead of turning them into a bar", () => {
    expect(resolveBudgetProgress({ turns: Number.NaN, maxTurns: 100 })).toBeNull();
    expect(resolveBudgetProgress({ turns: 10, maxTurns: Number.NaN })).toBeNull();
    expect(resolveBudgetProgress({ turns: Number.POSITIVE_INFINITY, maxTurns: 100 })).toBeNull();
    expect(resolveBudgetProgress({ billableTokens: 10, tokenLimit: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe("progress fallback chain", () => {
  const chainActivity = activity({
    taskId: "1233-a",
    chain: ["readme-guard", "architect", "coder", "reviewer", "tester", "documenter", "debugger"],
    statuses: {
      "readme-guard": "done",
      architect: "done",
      coder: "done",
      // Nepavykęs agentas NĖRA nueitas kelias.
      reviewer: "error",
      tester: "active",
      documenter: "pending",
      debugger: "pending",
    },
    currentAgent: "tester",
    mode: "subagents",
  });

  it("falls back to the agent chain when no budget is known", () => {
    const [view] = buildSlotProgressViews(
      input({
        loopControl: control([slot({ state: "running", taskId: "1233-a", attempt: 1 })]),
        activity: chainActivity,
      }),
    );

    expect(view.progress).toEqual({ signal: "chain", percent: 43, level: "normal", done: 3, total: 7 });
  });

  it("does not count an errored agent as done", () => {
    const [view] = buildSlotProgressViews(
      input({
        loopControl: control([slot({ state: "running", taskId: "1233-a", attempt: 1 })]),
        activity: chainActivity,
      }),
    );

    expect(view.progress).toMatchObject({ done: 3 });
    // 4 iš 7 (57 %) reikštų, kad klaida stumia juostą į priekį.
    expect(view.progress).not.toMatchObject({ percent: 57 });
  });

  it("says the progress is unknown when a running slot has neither a budget nor a chain", () => {
    const [view] = buildSlotProgressViews(
      input({ loopControl: control([slot({ state: "running", taskId: "1233-a", attempt: 1 })]) }),
    );

    expect(view.progress).toEqual({ signal: "indeterminate" });
  });

  it("shows no bar at all for an idle slot without a task", () => {
    const [view] = buildSlotProgressViews(input());

    expect(view.progress).toEqual({ signal: "none" });
  });

  it("prefers the budget bar over the chain bar when both exist", () => {
    const [view] = buildSlotProgressViews(
      input({
        loopControl: control([slot({ state: "running", taskId: "1233-a", attempt: 1 })]),
        activity: chainActivity,
        budgets: { w1: { turns: 40, maxTurns: 80 } },
      }),
    );

    expect(view.progress).toEqual({ signal: "budget", percent: 50, level: "normal", clamped: false });
  });
});

describe("resolveEta", () => {
  it("separates the three reasons a forecast is missing", () => {
    expect(resolveEta(undefined)).toEqual({ state: "unavailable", reason: "no-source" });
    expect(resolveEta({ lowMs: 60_000, highMs: 120_000, confidence: "high", basedOnSamples: 2 })).toEqual({
      state: "unavailable",
      reason: "not-enough-data",
    });
    expect(resolveEta({ lowMs: Number.NaN, highMs: 120_000, confidence: "high" })).toEqual({
      state: "unavailable",
      reason: "unparseable",
    });
    expect(resolveEta({ lowMs: 60_000, highMs: Number.POSITIVE_INFINITY, confidence: "high" })).toEqual({
      state: "unavailable",
      reason: "unparseable",
    });
    expect(resolveEta({ lowMs: -1, highMs: 120_000, confidence: "high" })).toEqual({
      state: "unavailable",
      reason: "unparseable",
    });
  });

  it("swaps an inverted range instead of rejecting it", () => {
    expect(resolveEta({ lowMs: 120_000, highMs: 60_000, confidence: "medium" })).toEqual({
      state: "available",
      lowMs: 60_000,
      highMs: 120_000,
      confidence: "medium",
    });
  });

  it("carries every confidence level through unchanged", () => {
    for (const confidence of ["high", "medium", "low"] as const) {
      expect(resolveEta({ lowMs: 60_000, highMs: 120_000, confidence, basedOnSamples: 12 })).toEqual({
        state: "available",
        lowMs: 60_000,
        highMs: 120_000,
        confidence,
      });
    }
  });
});

describe("correlateActivity", () => {
  const slots = [slot({ taskId: "1233-a" }), slot({ workerId: "w2", index: 2, taskId: "1233-b" })];

  it("attaches a live stream when exactly one slot owns the task", () => {
    expect(correlateActivity(activity({ taskId: "1233-b" }), slots)).toEqual({
      attachedTo: "w2",
      attribution: "attached",
    });
  });

  it("refuses to guess when two slots claim the same task", () => {
    const twins = [slot({ taskId: "dup" }), slot({ workerId: "w2", index: 2, taskId: "dup" })];

    expect(correlateActivity(activity({ taskId: "dup" }), twins)).toEqual({
      attachedTo: null,
      attribution: "ambiguous",
    });

    // Neįmanomas priskyrimas reiškia, kad grandinės negauna NĖ VIENAS srautas.
    const views = buildSlotProgressViews(
      input({
        loopControl: control(twins),
        activity: activity({ taskId: "dup", chain: ["coder"], statuses: { coder: "active" }, currentAgent: "coder" }),
      }),
    );
    expect(views.map((view) => view.chain)).toEqual([null, null]);
    expect(views.map((view) => view.liveness)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("treats an activity without a task id as unattributable", () => {
    expect(correlateActivity(activity({ taskId: null }), slots)).toEqual({
      attachedTo: null,
      attribution: "unknown",
    });
    expect(correlateActivity(null, slots)).toEqual({ attachedTo: null, attribution: "unknown" });
  });

  it("marks a live stream that matches no slot as detached", () => {
    expect(correlateActivity(activity({ taskId: "9999-orphan" }), slots)).toEqual({
      attachedTo: null,
      attribution: "unknown",
    });

    const views = buildSlotProgressViews(
      input({ loopControl: control(slots), activity: activity({ taskId: "9999-orphan" }) }),
    );
    expect(views.map((view) => view.liveness)).toEqual(["detached", "detached"]);
  });

  it("drops every attribution while the activity stream is disconnected", () => {
    const views = buildSlotProgressViews(
      input({
        loopControl: control(slots),
        activityStatus: "disconnected",
        activity: activity({ taskId: "1233-a", chain: ["coder"], statuses: { coder: "active" }, currentAgent: "coder" }),
      }),
    );

    expect(views.map((view) => view.liveness)).toEqual(["unknown", "unknown"]);
    expect(views.map((view) => view.chain)).toEqual([null, null]);
  });
});

describe("resolvePhase", () => {
  function phaseArgs(overrides: Partial<PhaseArgs> = {}): PhaseArgs {
    return {
      slotState: "idle",
      desired: "run",
      taskId: null,
      granted: null,
      rejectedReason: null,
      leaseState: null,
      currentAgent: null,
      attached: false,
      claudeStatus: null,
      ...overrides,
    };
  }

  it("separates an operator stop from a wave that granted nothing", () => {
    expect(resolvePhase(phaseArgs({ desired: "drain" }))).toEqual({ phase: "idle", phaseDetail: null });
    expect(resolvePhase(phaseArgs({ desired: "run", granted: false, rejectedReason: "legacy-reads" }))).toEqual({
      phase: "waiting",
      phaseDetail: "legacy-reads",
    });
    // Banga slot'ą išdavė, bet užduoties dar nėra: tai ramybė, ne laukimas eilėje.
    expect(resolvePhase(phaseArgs({ desired: "run", granted: true }))).toEqual({ phase: "idle", phaseDetail: null });
    expect(resolvePhase(phaseArgs({ desired: "run", granted: null }))).toEqual({ phase: "idle", phaseDetail: null });
  });

  it("maps a known agent to its phase and keeps the agent name as the detail", () => {
    expect(resolvePhase(phaseArgs({ taskId: "t", attached: true, currentAgent: "readme-guard" }))).toEqual({
      phase: "preflight",
      phaseDetail: "readme-guard",
    });
    expect(resolvePhase(phaseArgs({ taskId: "t", attached: true, currentAgent: "coder" }))).toEqual({
      phase: "implementation",
      phaseDetail: "coder",
    });
    expect(resolvePhase(phaseArgs({ taskId: "t", attached: true, currentAgent: "tester" }))).toEqual({
      phase: "review",
      phaseDetail: "tester",
    });
    expect(resolvePhase(phaseArgs({ taskId: "t", attached: true, currentAgent: "debugger" }))).toEqual({
      phase: "diagnosis",
      phaseDetail: "debugger",
    });
  });

  it("never guesses a phase from an unknown agent name", () => {
    expect(resolvePhase(phaseArgs({ taskId: "t", attached: true, currentAgent: "brand-new-agent" }))).toEqual({
      phase: "unknown",
      // Vardas rodomas PAŽODŽIUI: spėta fazė būtų melas, o vardas — faktas.
      phaseDetail: "brand-new-agent",
    });
  });

  it("falls back to the raw Claude status when no agent is reported", () => {
    expect(resolvePhase(phaseArgs({ taskId: "t", attached: true, claudeStatus: "compacting" }))).toEqual({
      phase: "unknown",
      phaseDetail: "compacting",
    });
  });

  it("uses the lease and the slot state only when nothing is attached", () => {
    expect(resolvePhase(phaseArgs({ taskId: "t", leaseState: "provisioned" }))).toEqual({
      phase: "preparing",
      phaseDetail: null,
    });
    expect(resolvePhase(phaseArgs({ taskId: "t", slotState: "draining" }))).toEqual({
      phase: "finishing",
      phaseDetail: null,
    });
    expect(resolvePhase(phaseArgs({ taskId: "t", slotState: "aborting" }))).toEqual({
      phase: "finishing",
      phaseDetail: null,
    });
    expect(resolvePhase(phaseArgs({ taskId: "t", slotState: "running" }))).toEqual({
      phase: "unknown",
      phaseDetail: null,
    });
  });

  it("lets the live agent win over the lease state", () => {
    // Tvarka yra kontraktas: dirbantis agentas yra naujesnis faktas nei „lease'as paruoštas".
    expect(
      resolvePhase(phaseArgs({ taskId: "t", attached: true, currentAgent: "reviewer", leaseState: "provisioned" })),
    ).toEqual({ phase: "review", phaseDetail: "reviewer" });
  });
});

describe("elapsedMsFrom", () => {
  it("prefers the acquisition timestamp", () => {
    expect(elapsedMsFrom(ACQUIRED_AT, 999, NOW)).toBe(240_000);
  });

  it("falls back to the server-side age when the timestamp is malformed", () => {
    expect(elapsedMsFrom("not-a-date", 61_000, NOW)).toBe(61_000);
  });

  it("returns null when neither source is usable", () => {
    expect(elapsedMsFrom("not-a-date", null, NOW)).toBeNull();
    expect(elapsedMsFrom(null, null, NOW)).toBeNull();
    expect(elapsedMsFrom(null, Number.NaN, NOW)).toBeNull();
    expect(elapsedMsFrom(null, -5, NOW)).toBeNull();
  });

  it("never reports a negative or NaN duration when the clocks disagree", () => {
    // `now` yra ANKSČIAU už lease'o paėmimą: skirtumas būtų neigiamas, tad jis nenaudojamas.
    const skewed = elapsedMsFrom(ACQUIRED_AT, null, Date.parse("2026-08-15T05:00:00.000Z"));
    expect(skewed).toBeNull();

    const withServerAge = elapsedMsFrom(ACQUIRED_AT, 7_000, Date.parse("2026-08-15T05:00:00.000Z"));
    expect(withServerAge).toBe(7_000);
    expect(withServerAge).toBeGreaterThanOrEqual(0);
  });
});

describe("buildSlotProgressViews lease handling", () => {
  it("does not let another task's lease feed the timer or the worktree", () => {
    const [view] = buildSlotProgressViews(
      input({
        loopControl: control([slot({ state: "running", taskId: "1233-new", attempt: 1 })]),
        waveSlots: [
          waveSlot({
            task_id: "1230-finished",
            last_failure: { ts: "2026-08-15T05:59:00.000Z", task_id: "1230-finished", reason: "exit 75" },
          }),
        ],
      }),
    );

    expect(view.elapsedMs).toBeNull();
    expect(view.worktree).toBe("unknown");
    expect(view.lease.mismatchedTask).toBe(true);
    expect(view.lease.known).toBe(true);
    // Gedimas neša SAVO `task_id` ir lieka faktu net tada, kai lease'as nebetinka.
    expect(view.lastError).toEqual({ ts: "2026-08-15T05:59:00.000Z", taskId: "1230-finished", reason: "exit 75" });
  });

  it("uses a matching lease for the elapsed time and the worktree flag", () => {
    const [view] = buildSlotProgressViews(
      input({
        loopControl: control([slot({ state: "running", taskId: "1233-a", attempt: 2 })]),
        waveSlots: [waveSlot({ task_id: "1233-a", has_worktree: false, stale: true, heartbeat_age_ms: 90_000 })],
      }),
    );

    expect(view.elapsedMs).toBe(240_000);
    expect(view.worktree).toBe("no");
    expect(view.lease).toEqual({
      known: true,
      status: "held",
      stale: true,
      heartbeatAgeMs: 90_000,
      mismatchedTask: false,
    });
  });

  it("keeps every stream visible when no wave data arrived at all", () => {
    const views = buildSlotProgressViews(
      input({
        loopControl: control([
          slot({ state: "running", taskId: "1233-a", attempt: 1 }),
          slot({ workerId: "w2", index: 2 }),
        ]),
        waveSlots: undefined,
      }),
    );

    // Slot'ai NIEKADA nedingsta dėl trūkstamo svetimo endpoint'o.
    expect(views).toHaveLength(2);
    expect(views.map((view) => view.workerId)).toEqual(["w1", "w2"]);
    for (const view of views) {
      expect(view.lease.known).toBe(false);
      expect(view.worktree).toBe("unknown");
      expect(view.elapsedMs).toBeNull();
    }
  });

  it("explains a blocked stream through the newest rejected refill decision", () => {
    const decisions: UiWaveRefillDecision[] = [
      {
        episode: 1,
        worker_id: "w1",
        task_id: "1233-a",
        granted: false,
        reason: "pool-exhausted",
        hard_capped: 0,
        decided_at: "2026-08-15T05:00:00.000Z",
        rejected: [],
      },
      {
        episode: 2,
        worker_id: "w1",
        task_id: "1233-b",
        granted: false,
        reason: "hard-cap",
        hard_capped: 2,
        decided_at: "2026-08-15T06:00:00.000Z",
        rejected: [],
      },
      { episode: 3, worker_id: "w2", task_id: "1233-c", granted: true, reason: "ok", hard_capped: 0, decided_at: "2026-08-15T06:02:00.000Z", rejected: [] },
    ];

    const [view] = buildSlotProgressViews(input({ refillDecisions: decisions }));

    expect(view.blocked).toEqual({ reason: "hard-cap", detail: "hard_capped=2" });
  });
});

describe("buildSlotProgressViews privacy", () => {
  it("never carries a filesystem path, an owner id or a token into the view", () => {
    const leaky = {
      ...waveSlot({ task_id: "1233-a" }),
      worktree_path: "D:/React/AG_loop/.worktrees/w1",
      owner_id: "operator-42",
      token: "s3cr3t-ui-token",
    } as unknown as UiWaveSlot;

    const views = buildSlotProgressViews(
      input({
        loopControl: control([slot({ state: "running", taskId: "1233-a", attempt: 1 })]),
        waveSlots: [leaky],
      }),
    );

    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain("worktree_path");
    expect(serialized).not.toContain(".worktrees");
    expect(serialized).not.toContain("owner_id");
    expect(serialized).not.toContain("operator-42");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("s3cr3t-ui-token");
    // Darbo kopija lieka vėliava, o ne kelias.
    expect(views[0].worktree).toBe("yes");
  });
});

/**
 * Per-srautinės grandinės (2026-08-24 UI auditas, aštuntas ratas).
 *
 * Serveris `slots[]` siunčia nuo daugiaslot'inės bangos — būtent todėl, kad globalus
 * `AgentActivity` yra projekcija ant VIENO `claude-last.log`, kurį lygiagretūs worker'iai perrašo
 * vienas per kitą. Klientas šio lauko NESKAITĖ, tad dviejų srautų bangoje grandinė buvo
 * priskiriama spėjant pagal `task_id` sutapimą su tuo pačiu globaliu log'u.
 */
describe("buildSlotProgressViews su per-srautinėmis grandinėmis", () => {
  const runningSlots = [
    slot({ workerId: "w1", index: 1, state: "running", taskId: "0041", attempt: 1 }),
    slot({ workerId: "w2", index: 2, state: "running", taskId: "0042", attempt: 1 }),
  ];

  const slotActivities = [
    {
      worker_id: "w1",
      task_id: "0041",
      attempt: 1,
      log_path: "vq/runtime/w1/claude-last.log",
      activity: activity({
        taskId: "0041",
        chain: ["coder", "reviewer"],
        statuses: { coder: "done" },
        currentAgent: "reviewer",
      }),
    },
    {
      worker_id: "w2",
      task_id: "0042",
      attempt: 1,
      log_path: "vq/runtime/w2/claude-last.log",
      activity: activity({ taskId: "0042", chain: ["tester"], statuses: {}, currentAgent: "tester" }),
    },
  ];

  it("KIEKVIENAS srautas gauna SAVO grandinę, ne globalaus log'o paskutinio rašytojo", () => {
    // Globalus srautas kalba apie w2 — jis rašė paskutinis. Be `slots[]` w1 liktų be grandinės,
    // nors dirba, o jo fazė būtų „nežinoma".
    const views = buildSlotProgressViews(
      input({ loopControl: control(runningSlots), activity: activity({ taskId: "0042" }), slotActivities }),
    );

    expect(views[0]?.chain?.agents).toEqual(["coder", "reviewer"]);
    expect(views[0]?.chain?.currentAgent).toBe("reviewer");
    expect(views[1]?.chain?.agents).toEqual(["tester"]);
    expect(views[1]?.chain?.currentAgent).toBe("tester");
    expect(views.map((view) => view.liveness)).toEqual(["attached", "attached"]);
  });

  it("dvi užduotys tuo pačiu vardu nebedaro priskyrimo dviprasmiško", () => {
    // Koreliacija pagal `task_id` čia grąžintų `ambiguous` ir nerodytų NIEKO. Turint srauto SAVO
    // įrašą, vardų sutapimas priskyrimo nebeliečia.
    const sameTask = [
      slot({ workerId: "w1", index: 1, state: "running", taskId: "0041", attempt: 1 }),
      slot({ workerId: "w2", index: 2, state: "running", taskId: "0041", attempt: 2 }),
    ];
    const views = buildSlotProgressViews(
      input({ loopControl: control(sameTask), activity: activity({ taskId: "0041" }), slotActivities }),
    );

    expect(views[0]?.chain?.currentAgent).toBe("reviewer");
    expect(views[0]?.phase).toBe("review");
    expect(views.map((view) => view.liveness)).toEqual(["attached", "attached"]);
  });

  it("be `slots[]` elgesys NEPAKITĘS — senas serveris lieka veikiantis", () => {
    const views = buildSlotProgressViews(
      input({ loopControl: control(runningSlots), activity: activity({ taskId: "0042" }) }),
    );

    expect(views[0]?.chain).toBeNull();
    expect(views[1]?.liveness).toBe("attached");
  });

  it("nutrūkęs srautas panaikina priskyrimą net turint įrašus", () => {
    // `disconnected` reiškia, kad duomenys gali būti pasenę; skelbti „prisegta" tada būtų
    // tvirtinimas apie tai, ko nebežinome.
    const views = buildSlotProgressViews(
      input({
        loopControl: control(runningSlots),
        activity: activity({ taskId: "0042" }),
        slotActivities,
        activityStatus: "disconnected",
      }),
    );

    expect(views.map((view) => view.liveness)).toEqual(["unknown", "unknown"]);
    expect(views[0]?.chain).toBeNull();
  });
});
