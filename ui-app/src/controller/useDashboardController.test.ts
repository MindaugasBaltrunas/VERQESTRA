import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../model/api";
import type { DashboardData, LoopControlData, WorkerControlData } from "../model/types";
import { useDashboardController } from "./useDashboardController";

/** Paskutinis veiksmo pranešimas — nuo task 1235 būtent jis, o ne `notice`, neša mutacijų rezultatą. */
function lastToast(toasts: readonly { tone: string; message: string }[]) {
  return toasts.at(-1);
}

// Visas tinklo sluoksnis mock'inamas: kontroleris testuojamas kaip elgsena („ką jis daro su
// atsakymu"), o ne kaip HTTP klientas.
vi.mock("../model/api", () => ({
  getUiToken: () => "test-token",
  fetchDashboard: vi.fn(),
  setRequestedWorkers: vi.fn(),
  startLoopWithWorkers: vi.fn(),
  setSlotMode: vi.fn(),
  triageTask: vi.fn(),
  resumeLoop: vi.fn(),
  stopLoop: vi.fn(),
  uploadTaskFiles: vi.fn(),
  openFolder: vi.fn(),
  fetchWorkflowTasks: vi.fn(),
  proposePolicy: vi.fn(),
  approveLearningRecommendation: vi.fn(),
  rejectLearningRecommendation: vi.fn(),
}));

function dashboard(workerControl: WorkerControlData, loopControl?: LoopControlData): DashboardData {
  return {
    ...(loopControl === undefined ? {} : { loopControl }),
    root: "D:/project",
    currentTaskId: null,
    currentTaskFile: null,
    claudeExit: null,
    stableRef: null,
    stopStatus: {},
    decision: {},
    supervisorResume: {},
    claudeResume: {},
    runtime: [{ name: "AG loop", status: "stopped" }],
    claudeLogUpdatedAt: null,
    claudeLogBytes: null,
    workflowBuckets: [],
    workerControl,
  };
}

const oneWorker: WorkerControlData = { requested: 1, source: "state", envOverride: false, lastWave: null };
const twoWorkers: WorkerControlData = { requested: 2, source: "state", envOverride: false, lastWave: null };

describe("useDashboardController worker slots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `useAgentActivity` prenumeruoja `/api/events` tiesiogiai per `fetch`. Testinis stub'as
    // laiko ryšį „neprisijungusį", kad testas neieškotų tikro serverio.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sse disabled in tests")));
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard(oneWorker));
  });

  it("sends the request and reloads the dashboard with the state that took effect", async () => {
    vi.mocked(api.setRequestedWorkers).mockResolvedValue({
      worker_request: { requested: 2, source: "state", envOverride: false },
    });

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());
    expect(result.current.dashboard?.workerControl.requested).toBe(1);

    // Serveris jau turi naują būseną: perkrovimas yra vienintelis būdas parodyti, kas ĮSIGALIOJO
    // (aplinkos kintamasis gali prašymą perrašyti).
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard(twoWorkers));
    await act(async () => {
      await result.current.actions.setRequestedWorkers(2);
    });

    expect(api.setRequestedWorkers).toHaveBeenCalledWith(2);
    await waitFor(() => expect(result.current.dashboard?.workerControl.requested).toBe(2));
    expect(result.current.notice).toBeNull();
  });

  it("turns a rejected request into an error message instead of an unhandled rejection", async () => {
    vi.mocked(api.setRequestedWorkers).mockRejectedValue(
      new Error("HTTP 400: requested must be an integer between 1 and 2"),
    );

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      // Veiksmas NETURI mesti: mygtuko paspaudimas be `catch` paliktų neapdorotą promise atmetimą.
      await result.current.actions.setRequestedWorkers(2);
    });

    const toast = lastToast(result.current.toasts);
    expect(toast?.tone).toBe("error");
    // Prefiksas pasako, KAS nepavyko, o serverio tekstas — ką operatorius gali padaryti. Reikia abiejų.
    expect(toast?.message).toContain("Could not change the worker count");
    expect(toast?.message).toContain("requested must be an integer between 1 and 2");
    // Rodomi duomenys lieka tie, kuriuos serveris patvirtino.
    expect(result.current.dashboard?.workerControl.requested).toBe(1);
  });
});

// Srautų gyvavimo ciklas (task 0052).
const runningStreams: LoopControlData = {
  loop: { status: "running", stopRequested: false },
  slots: [
    {
      worker_id: "w1",
      worker_index: 1,
      desired: "run",
      state: "running",
      task_id: "0052-a",
      attempt: 1,
      lastWave: null,
    },
  ],
};

describe("useDashboardController loop streams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sse disabled in tests")));
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard(oneWorker));
  });

  it("starts the loop with the chosen stream count and reloads the state that took effect", async () => {
    vi.mocked(api.startLoopWithWorkers).mockResolvedValue({ status: "started", pid: 4242 });

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());
    // Serveris srautų bloko dar nesiuntė: numatytoji būsena, o ne klaida.
    expect(result.current.dashboard?.loopControl.known).toBe(false);

    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard(twoWorkers, runningStreams));
    await act(async () => {
      await result.current.actions.startLoopWithWorkers(2);
    });

    expect(api.startLoopWithWorkers).toHaveBeenCalledWith(2);
    await waitFor(() => expect(result.current.dashboard?.loopControl.slots[0]?.taskId).toBe("0052-a"));
    expect(lastToast(result.current.toasts)).toMatchObject({
      tone: "success",
      message: "Loop started with 2 stream(s).",
    });
  });

  it("maps stop, resume, and abort onto the one slot-mode write path", async () => {
    vi.mocked(api.setSlotMode).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      await result.current.actions.stopSlot("w2");
      await result.current.actions.resumeSlot("w2");
      await result.current.actions.abortSlot("w1");
    });

    // Numatytasis srauto stabdymas yra `drain`, o ne `abort`.
    expect(api.setSlotMode).toHaveBeenNthCalledWith(1, "w2", "drain");
    expect(api.setSlotMode).toHaveBeenNthCalledWith(2, "w2", "run");
    expect(api.setSlotMode).toHaveBeenNthCalledWith(3, "w1", "abort");
    // Kiekvienas veiksmas įvardija SAVO srautą: „srautas sustos" ir „srautas tęsiamas" negali
    // atrodyti kaip vienas bendras „pavyko".
    expect(result.current.toasts.map((toast) => toast.message)).toEqual([
      "Stream 2 will stop after the current attempt.",
      "Stream 2 resumed.",
      "Stream 1 is marked as aborting; the running attempt still finishes.",
    ]);
  });

  it("turns a rejected start into an error message instead of an unhandled rejection", async () => {
    vi.mocked(api.startLoopWithWorkers).mockRejectedValue(
      new Error("HTTP 400: workers must be an integer between 1 and 2"),
    );

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      await result.current.actions.startLoopWithWorkers(2);
    });

    const toast = lastToast(result.current.toasts);
    expect(toast?.tone).toBe("error");
    expect(toast?.message).toContain("Could not start the loop streams");
    expect(toast?.message).toContain("workers must be an integer between 1 and 2");
  });

  it("turns a rejected slot change into an error message instead of an unhandled rejection", async () => {
    vi.mocked(api.setSlotMode).mockRejectedValue(new Error("HTTP 400: unknown worker id"));

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      await result.current.actions.abortSlot("w2");
    });

    const toast = lastToast(result.current.toasts);
    expect(toast?.message).toContain("Could not change the stream state");
    expect(toast?.message).toContain("unknown worker id");
  });
});

// Užstrigusios užduoties grąžinimas į eilę ir ciklo perkrovimas (task 1235).
describe("useDashboardController triage and restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sse disabled in tests")));
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard(oneWorker));
  });

  it("sends a stuck task back to the queue through the same server route as the review panel", async () => {
    vi.mocked(api.triageTask).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());
    const loadsBefore = vi.mocked(api.fetchDashboard).mock.calls.length;

    await act(async () => {
      await result.current.actions.fixSlotTask("0900-x");
    });

    expect(api.triageTask).toHaveBeenCalledWith("requeue", "0900-x");
    expect(lastToast(result.current.toasts)?.message).toBe("Task 0900-x was sent back to the queue.");
    // Perkraunama, nes tik kitas snapshot'as pasako, kur užduotis atsidūrė.
    await waitFor(() => expect(vi.mocked(api.fetchDashboard).mock.calls.length).toBeGreaterThan(loadsBefore));
  });

  it("reports the server's refusal word for word", async () => {
    vi.mocked(api.triageTask).mockRejectedValue(
      new Error("HTTP 409: task is in 'queue'; only 'human-review' tasks can be triaged from the UI"),
    );

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      await result.current.actions.fixSlotTask("0900-x");
    });

    const toast = lastToast(result.current.toasts);
    expect(toast?.tone).toBe("error");
    expect(toast?.message).toContain("Could not send the task back to the queue");
    expect(toast?.message).toContain("only 'human-review' tasks can be triaged from the UI");
  });

  it("restarts only after the dashboard confirms the loop stopped", async () => {
    vi.mocked(api.stopLoop).mockResolvedValue({ status: "stop-requested", pid: 42 });
    vi.mocked(api.startLoopWithWorkers).mockResolvedValue({ status: "started", pid: 77 });

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      // Trumpas intervalas per `overrides`: neigiamas kelias kitaip truktų realias 15 sekundžių.
      await result.current.actions.restartLoop(2, { pollAttempts: 3, pollIntervalMs: 1 });
    });

    expect(api.stopLoop).toHaveBeenCalledOnce();
    expect(api.startLoopWithWorkers).toHaveBeenCalledWith(2);
    expect(lastToast(result.current.toasts)).toMatchObject({ tone: "success", message: "Loop restarted." });
  });

  it("refuses to start a loop that never confirmed it stopped", async () => {
    vi.mocked(api.stopLoop).mockResolvedValue({ status: "stop-requested", pid: 42 });
    // Dashboard'as visą laiką sako „veikia": tai NĖRA leidimas paleisti antrą orkestratorių.
    vi.mocked(api.fetchDashboard).mockResolvedValue(
      dashboard(oneWorker, { loop: { status: "running", stopRequested: true }, slots: [] }),
    );

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      await result.current.actions.restartLoop(1, { pollAttempts: 2, pollIntervalMs: 1 });
    });

    expect(api.startLoopWithWorkers).not.toHaveBeenCalled();
    const toast = lastToast(result.current.toasts);
    expect(toast?.tone).toBe("error");
    expect(toast?.message).toContain(
      "Restart cancelled: the loop is still running after the stop request, so it was not restarted.",
    );
  });
});
