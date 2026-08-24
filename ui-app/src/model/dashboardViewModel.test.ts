import { describe, expect, it } from "vitest";
import type { DashboardData, LoopControlData, LoopSlotData } from "./types";
import {
  adaptLoopControl,
  adaptOverview,
  adaptWorkerControl,
  adaptWorkflowBuckets,
  sanitizeLogLine,
  statusVariant,
} from "./dashboardViewModel";

describe("stop įrodymo kilmė ir korupcija", () => {
  // 2026-08-24: serveris `stopStatusSource`/`stopStatusCorrupted` siunčia nuo pirmo audito rato su
  // komentaru „kilmė rodoma, o ne nutylima" — bet klientas jų NESKAITĖ. Sugadintas įrodymas ekrane
  // atrodė kaip tuščias „pending", nors tai priešingi faktai: pirmu atveju įrodymas RASTAS ir
  // neperskaitomas (serveris sąmoningai nenusileidžia prie legacy veidrodžio), antru — jo nėra.
  const base = (over: Partial<DashboardData>): DashboardData => ({
    root: "/repo",
    currentTaskId: null,
    currentTaskFile: null,
    claudeExit: null,
    stableRef: null,
    stopStatus: {},
    decision: {},
    supervisorResume: {},
    claudeResume: {},
    runtime: [],
    claudeLogUpdatedAt: null,
    claudeLogBytes: null,
    workflowBuckets: [],
    ...over,
  });

  it("sugadintas įrodymas pavadinamas ir dažomas klaida", () => {
    const metric = adaptOverview(base({ stopStatusCorrupted: true, stopStatusSource: "attempt" }))[1];
    expect(metric?.label).toBe("Stop status (unreadable)");
    expect(metric?.value).toBe("corrupted");
    expect(metric?.variant).toBe("error");
  });

  it("kilmė pasiekiama: `legacy` gali priklausyti KITAM task'ui", () => {
    const metric = adaptOverview(base({ stopStatus: { status: "done" }, stopStatusSource: "legacy" }))[1];
    expect(metric?.title).toBe("source: legacy");
    expect(metric?.variant).toBe("good");
  });

  it("senas `dist` be kilmės laukų elgesio nekeičia", () => {
    const metric = adaptOverview(base({ stopStatus: { status: "done" } }))[1];
    expect(metric?.label).toBe("Stop status");
    expect(metric?.title).toBeUndefined();
  });
});

describe("dashboardViewModel", () => {
  it("removes ANSI control sequences and bounds oversized log lines", () => {
    expect(sanitizeLogLine("\u001b[31mError\u001b[0m")).toBe("Error");

    const sanitized = sanitizeLogLine("x".repeat(5_000));
    expect(sanitized).toHaveLength(4_015);
    expect(sanitized).toMatch(/\[sutrumpinta\]$/);
  });

  // 2026-08-06 UI auditas: substring matching be žodžio ribų ir bloga šakų tvarka.
  it("classifies statuses by severity, not by accidental substrings", () => {
    // `/ok/` be žodžio ribos anksčiau dažydavo `revoked` žaliai.
    expect(statusVariant("revoked")).not.toBe("good");
    expect(statusVariant("broken")).not.toBe("good");

    // `human-review-failed` yra gedimas, o ne laukimas: `error` šaka tikrinama pirma.
    expect(statusVariant("human-review-failed")).toBe("error");
    expect(statusVariant("human-review")).toBe("warning");

    // Realūs workflow verdiktai anksčiau iškrisdavo į `neutral` ir atrodydavo kaip ramybė.
    expect(statusVariant("retry")).toBe("warning");
    expect(statusVariant("follow-up")).toBe("warning");
    expect(statusVariant("escalate")).toBe("warning");
    expect(statusVariant("duplicate")).toBe("error");

    // Žinomos reikšmės nepakito.
    expect(statusVariant("done")).toBe("good");
    expect(statusVariant("active")).toBe("live");
    expect(statusVariant("stopped")).toBe("neutral");
    expect(statusVariant(undefined)).toBe("neutral");
  });

  it("keeps backend workflow totals when only recent tasks are returned", () => {
    const [bucket] = adaptWorkflowBuckets([{ name: "done", tasks: ["latest.md"], totalCount: 346 }]);
    expect(bucket?.totalTasks).toBe(346);
  });
});

  it("classifies delegated as live and a deliberately stopped process as neutral", () => {
    expect(statusVariant("delegated")).toBe("live");
    expect(statusVariant("stopped")).toBe("neutral");
  });

  it("surfaces a stale current-task state instead of presenting it as active", () => {
    const [metric] = adaptOverview({
      currentTaskId: "981-example",
      currentTaskFile: "C:/repo/AG/tasks/active/981-example.md",
      currentTaskBucket: "queue",
      currentTaskState: "stale",
      stopStatus: {},
      decision: {},
      claudeExit: null,
      claudeResume: {},
      claudeLogUpdatedAt: null,
      stableRef: null,
    } as never);

    // Etiketės yra vertimų RAKTAI, todėl rašomos angliškai; LT vertimas gyvena žodyne.
    // Anksčiau čia buvo lietuviškas literalas, kuris EN režime likdavo neišverstas.
    expect(metric).toMatchObject({
      label: "Stale task state",
      value: "981-example (queue)",
      variant: "warning",
    });
  });

// Worker slot'ų valdiklis (task 0051). Adapteris yra vienintelė vieta, kur serverio duomenys virsta
// „ar valdiklį apskritai galima naudoti", tad būtent čia tikrinami kraštai, o ne komponente.
describe("adaptWorkerControl", () => {
  it("treats a server without the worker block as one editable worker", () => {
    // Senas UI serveris (senas `dist`) šio bloko dar nesiunčia — tai numatytoji sistemos būsena,
    // o ne klaida, tad valdiklis privalo likti veikiantis.
    expect(adaptWorkerControl(undefined)).toEqual({
      requested: 1,
      source: "default",
      canEdit: true,
      lastWaveKnown: false,
      granted: 0,
      grantedOf: 1,
      max: 0,
      rejected: [],
    });
  });

  it("disables editing when the environment dictates the value", () => {
    const view = adaptWorkerControl({ requested: 2, source: "env", envOverride: true, lastWave: null });

    expect(view.canEdit).toBe(false);
    expect(view.requested).toBe(2);
    // Bangos dar nebuvo: rezultato rodyti nėra iš ko, ir `max` negali tapti mygtukų šaltiniu.
    expect(view.lastWaveKnown).toBe(false);
    expect(view.max).toBe(0);
  });

  it("keeps the file problem code and stays editable for a state-sourced request", () => {
    const view = adaptWorkerControl({
      requested: 1,
      source: "default",
      envOverride: false,
      invalid: "malformed",
      lastWave: null,
    });

    expect(view.invalid).toBe("malformed");
    expect(view.canEdit).toBe(true);
  });

  it("normalizes the last wave result and its rejections", () => {
    const view = adaptWorkerControl({
      requested: 2,
      source: "state",
      envOverride: false,
      lastWave: {
        mode: "sequential",
        requested: 2,
        granted: 1,
        max: 2,
        rejected: [{ task_id: "0502-beta", reason: "legacy-reads", detail: "stop-status read by verify-task" }],
      },
    });

    expect(view.lastWaveKnown).toBe(true);
    expect(view.granted).toBe(1);
    expect(view.grantedOf).toBe(2);
    expect(view.max).toBe(2);
    // `reason` yra pool'o KODAS — jis nekeičiamas į sakinį, nes būtent jo ieškoma log'e ir
    // snapshot'e.
    expect(view.rejected).toEqual([
      { taskId: "0502-beta", reason: "legacy-reads", detail: "stop-status read by verify-task" },
    ]);
  });
});

// Srautų valdiklis (task 0052). Adapteris yra vienintelė vieta, kur serverio faktai virsta tuo, ką
// operatorius mato, tad būtent čia tikrinami kraštai.
function loopSlot(overrides: Partial<LoopSlotData> = {}): LoopSlotData {
  return {
    worker_id: "w1",
    worker_index: 1,
    desired: "run",
    state: "idle",
    task_id: null,
    attempt: null,
    lastWave: null,
    ...overrides,
  };
}

function loopControlData(overrides: Partial<LoopControlData> = {}): LoopControlData {
  return {
    loop: { status: "running", stopRequested: false },
    slots: [loopSlot()],
    ...overrides,
  };
}

describe("adaptLoopControl", () => {
  it("treats a server without the loop-control block as two running-capable idle streams", () => {
    // Senas UI serveris (senas `dist`) šio bloko nesiunčia — tai numatytoji būsena, ne klaida.
    expect(adaptLoopControl(undefined)).toEqual({
      known: false,
      loopStatus: "unknown",
      stopRequested: false,
      slots: [
        { workerId: "w1", index: 1, desired: "run", state: "idle", taskId: null, attempt: null, lastWave: null },
        { workerId: "w2", index: 2, desired: "run", state: "idle", taskId: null, attempt: null, lastWave: null },
      ],
    });
  });

  it("reports a running stream with a stop request as draining, and an abort request as aborting", () => {
    const [draining] = adaptLoopControl(
      loopControlData({ slots: [loopSlot({ desired: "drain", state: "running", task_id: "0052-a", attempt: 1 })] }),
    ).slots;
    const [aborting] = adaptLoopControl(
      loopControlData({ slots: [loopSlot({ desired: "abort", state: "running" })] }),
    ).slots;

    expect(draining).toMatchObject({ state: "draining", taskId: "0052-a", attempt: 1 });
    expect(aborting?.state).toBe("aborting");
  });

  it("turns the wave grant count into this stream's own verdict", () => {
    const view = adaptLoopControl(
      loopControlData({
        slots: [
          loopSlot({ lastWave: { wave_id: "w-1", granted: 1, rejected_reason: null } }),
          loopSlot({
            worker_id: "w2",
            worker_index: 2,
            lastWave: { wave_id: "w-1", granted: 1, rejected_reason: "legacy-reads" },
          }),
        ],
      }),
    );

    // Banga išdavė vieną slot'ą: pirmas gavo, antras — ne, nors abu neša tą patį skaičių.
    expect(view.slots[0]?.lastWave).toEqual({ waveId: "w-1", granted: true, rejectedReason: null });
    expect(view.slots[1]?.lastWave).toEqual({ waveId: "w-1", granted: false, rejectedReason: "legacy-reads" });
  });

  it("passes the control-file problem code and loop state through untouched", () => {
    const view = adaptLoopControl(
      loopControlData({ loop: { status: "stopped", stopRequested: true }, invalid: "schema" }),
    );

    expect(view.invalid).toBe("schema");
    expect(view.known).toBe(true);
    expect(view.loopStatus).toBe("stopped");
    expect(view.stopRequested).toBe(true);
  });
});
