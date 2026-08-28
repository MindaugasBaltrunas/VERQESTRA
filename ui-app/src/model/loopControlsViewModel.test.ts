import { describe, expect, it } from "vitest";
import type { WorkerControlView } from "./dashboardViewModel";
import {
  buildLoopControlsView,
  fixableTaskIds,
  loopRunStateOf,
  startStreamCount,
  streamIndexOf,
  workerChoices,
  LOOP_RESTART_ACTION,
  LOOP_START_ACTION,
  LOOP_STOP_ACTION,
} from "./loopControlsViewModel";
import type { DashboardData, LoopControlData, RuntimeProcess, UiHumanReviewTask } from "./types";

const ALL_HANDLERS = { start: true, stop: true, restart: true };

function view(
  status: "running" | "stopped" | "unknown",
  pending: string[] = [],
  handlers = ALL_HANDLERS,
) {
  return buildLoopControlsView({ status, handlers, pending: new Set(pending) });
}

describe("buildLoopControlsView", () => {
  // 2026-08-06: senas UI nemokėjo perskaityti naujo PID įrašo, būsena tapo `unknown`, ir „Paleisti"
  // liko aktyvus — tai buvo pasiūlymas paleisti ANTRĄ orkestratorių tame pačiame repo.
  it("never offers a start while the loop state is unconfirmed", () => {
    const buttons = view("unknown");

    expect(buttons.start.enabled).toBe(false);
    // Stabdymas lieka: stop vėliavos įrašymas nekenksmingas ir veikia net terminale paleistam ciklui.
    expect(buttons.stop.enabled).toBe(true);
    // Perkrovimas savyje turi paleidimą, tad nežinomybėje jis uždarytas kartu su juo.
    expect(buttons.restart.enabled).toBe(false);
  });

  it("offers stop and restart while the loop runs, but not another start", () => {
    const buttons = view("running");

    expect(buttons.start.enabled).toBe(false);
    expect(buttons.stop.enabled).toBe(true);
    expect(buttons.restart.enabled).toBe(true);
  });

  it("offers only a start once the loop is stopped", () => {
    const buttons = view("stopped");

    expect(buttons.start.enabled).toBe(true);
    expect(buttons.stop.enabled).toBe(false);
    expect(buttons.restart.enabled).toBe(false);
  });

  it("locks all three while any of them is still running", () => {
    for (const pendingId of [LOOP_START_ACTION, LOOP_STOP_ACTION, LOOP_RESTART_ACTION]) {
      const buttons = view("running", [pendingId]);

      expect(buttons.start.enabled).toBe(false);
      expect(buttons.stop.enabled).toBe(false);
      expect(buttons.restart.enabled).toBe(false);
      // Suktukas rodomas TIK ant to mygtuko, kuris tikrai laukia atsakymo.
      const busy = [buttons.start, buttons.stop, buttons.restart].filter((button) => button.busy);
      expect(busy.map((button) => button.id)).toEqual([pendingId]);
    }
  });

  it("stays disabled without a handler even in the state that would allow it", () => {
    const buttons = view("running", [], { start: false, stop: false, restart: false });

    expect(buttons.stop.enabled).toBe(false);
    expect(buttons.restart.enabled).toBe(false);
    expect(view("stopped", [], { start: false, stop: true, restart: true }).start.enabled).toBe(false);
  });
});

function dashboard(overrides: { loopControl?: LoopControlData; runtime?: RuntimeProcess[] } = {}): DashboardData {
  return {
    ...(overrides.loopControl === undefined ? {} : { loopControl: overrides.loopControl }),
    root: "D:/project",
    currentTaskId: null,
    currentTaskFile: null,
    claudeExit: null,
    stableRef: null,
    stopStatus: {},
    decision: {},
    supervisorResume: {},
    claudeResume: {},
    runtime: overrides.runtime ?? [],
    claudeLogUpdatedAt: null,
    claudeLogBytes: null,
    workflowBuckets: [],
  };
}

describe("loopRunStateOf", () => {
  it("believes the loop control file first", () => {
    const data = dashboard({
      loopControl: { loop: { status: "running", stopRequested: false }, slots: [] },
      runtime: [{ name: "AG loop", status: "stopped" }],
    });

    expect(loopRunStateOf(data)).toBe("running");
  });

  it("falls back to the runtime process list when the server sends no loop control block", () => {
    expect(loopRunStateOf(dashboard({ runtime: [{ name: "AG loop", status: "stopped" }] }))).toBe("stopped");
  });

  it("reports unknown when no source can answer, instead of guessing 'stopped'", () => {
    expect(loopRunStateOf(dashboard())).toBe("unknown");
  });
});

function workerControl(requested: number, max = 0): WorkerControlView {
  return { requested, source: "state", canEdit: true, lastWaveKnown: max > 0, granted: 0, grantedOf: 1, max, rejected: [] };
}

describe("startStreamCount", () => {
  it("offers one stream when nothing is known", () => {
    expect(startStreamCount(undefined)).toBe(1);
  });

  it("offers exactly what is requested", () => {
    expect(startStreamCount(workerControl(2))).toBe(2);
    expect(startStreamCount(workerControl(1))).toBe(1);
  });

  it("never offers more than the server contract allows", () => {
    // Sugadintas prašymo failas gali atnešti bet kokį skaičių; paleidimas priima tik 1 arba 2.
    expect(startStreamCount(workerControl(7))).toBe(1);
    expect(startStreamCount(workerControl(0))).toBe(1);
  });

  it("does not cap when max is unknown (0)", () => {
    expect(startStreamCount(workerControl(2, 0))).toBe(2);
  });

  it("caps at max=1 even when 2 is requested", () => {
    expect(startStreamCount(workerControl(2, 1))).toBe(1);
  });

  it("allows 2 when max=2", () => {
    expect(startStreamCount(workerControl(2, 2))).toBe(2);
  });
});

describe("workerChoices", () => {
  it("leaves both choices available when workerControl is missing", () => {
    expect(workerChoices(undefined)).toEqual([
      { count: 1, available: true },
      { count: 2, available: true },
    ]);
  });

  it("leaves both choices available when max is unknown (0, no wave yet)", () => {
    expect(workerChoices(workerControl(1, 0))).toEqual([
      { count: 1, available: true },
      { count: 2, available: true },
    ]);
  });

  it("closes stream 2 when max=1", () => {
    expect(workerChoices(workerControl(1, 1))).toEqual([
      { count: 1, available: true },
      { count: 2, available: false, unavailableReason: "exceeds-max" },
    ]);
  });

  it("leaves both choices available when max=2", () => {
    expect(workerChoices(workerControl(1, 2))).toEqual([
      { count: 1, available: true },
      { count: 2, available: true },
    ]);
  });
});

describe("streamIndexOf", () => {
  it("translates the internal worker id into the number the operator sees", () => {
    expect(streamIndexOf("w1")).toBe(1);
    expect(streamIndexOf("w2")).toBe(2);
  });
});

describe("fixableTaskIds", () => {
  function task(taskId: string): UiHumanReviewTask {
    return { file: `AG/tasks/human-review/${taskId}.md`, task_id: taskId, title: taskId, preview: "", actions: [] };
  }

  it("lists exactly the tasks the server allows to be requeued", () => {
    expect(fixableTaskIds([task("1235-a"), task("1235-b")])).toEqual(new Set(["1235-a", "1235-b"]));
  });

  it("is empty when nothing waits for a human", () => {
    expect(fixableTaskIds([]).size).toBe(0);
  });
});
