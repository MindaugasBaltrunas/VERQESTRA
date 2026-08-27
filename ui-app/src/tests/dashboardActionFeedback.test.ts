import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../model/api";
import type { DashboardData, LoopResult, WorkerControlData } from "../model/types";
import { useDashboardController } from "../controller/useDashboardController";

/**
 * Task 048: „Paleisti" (Header) ir rankinis atnaujinimas anksčiau apeidavo `run()` — nebuvo
 * dvigubo paspaudimo apsaugos, o po klaidos mygtukas užsirakindavo net kai veiksmas jau seniai
 * baigėsi (žr. `useDashboardController.ts` `buildLoopControls` iškvietimą). Šie testai tikrina
 * abu pataisytus dalykus TIESIOGIAI per `loopControls`/`pendingActions`, o ne per etiketės tekstą.
 */

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

function dashboard(workerControl: WorkerControlData): DashboardData {
  return {
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

const oneWorker: WorkerControlData = { requested: 1, source: "state", lastWave: null };

describe("useDashboardController — vieningas veiksmų feedback (task 048)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sse disabled in tests")));
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard(oneWorker));
  });

  it("resumeLoop: dvigubas paspaudimas eina per run() ir siunčia VIENĄ POST", async () => {
    let release: ((value: LoopResult) => void) | null = null;
    vi.mocked(api.resumeLoop).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    // Du paspaudimai TOJE PAČIOJE partijoje, be `await` tarp jų — kaip greitas dvigubas paspaudimas.
    act(() => {
      void result.current.actions.resumeLoop();
      void result.current.actions.resumeLoop();
    });

    expect(api.resumeLoop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.pendingActions.has("loop-resume")).toBe(true));
    // Kol veiksmas vyksta, Header'io „Paleisti" NEGALI būti paspaudžiamas antrą kartą.
    expect(result.current.loopControls.canResume).toBe(false);

    await act(async () => {
      release?.({ status: "started", pid: 4242 });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.pendingActions.has("loop-resume")).toBe(false));
    expect(result.current.toasts.at(-1)?.tone).toBe("success");
  });

  it("resumeLoop: nesėkmė praneša toast'u ir NEUŽRAKINA mygtuko amžinai", async () => {
    vi.mocked(api.resumeLoop).mockRejectedValue(new Error("HTTP 500: orchestrator busy"));

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());
    // Ciklas sustojęs (runtime fixture'as), tad prieš veiksmą paleidimas leidžiamas.
    expect(result.current.loopControls.canResume).toBe(true);

    await act(async () => {
      // Veiksmas NETURI mesti: mygtuko paspaudimas be `catch` paliktų neapdorotą promise atmetimą.
      await result.current.actions.resumeLoop();
    });

    const toast = result.current.toasts.at(-1);
    expect(toast?.tone).toBe("error");
    expect(toast?.message).toContain("orchestrator busy");
    // Veiksmas jau baigėsi (nebe pending) — mygtukas privalo vėl leisti bandyti, o ne likti
    // užrakintas kelias sekundes dėl mygtuko TEKSTO, kuris dar nespėjo atsistatyti.
    expect(result.current.pendingActions.has("loop-resume")).toBe(false);
    expect(result.current.loopControls.canResume).toBe(true);
  });

  it("reload: dvigubas paspaudimas siunčia VIENĄ užklausą ir žymi mygtuką užimtu per pendingActions", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    vi.mocked(api.fetchDashboard).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(dashboard(oneWorker));
      return new Promise((resolve) => {
        release = () => resolve(dashboard(oneWorker));
      });
    });

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());
    const callsAfterMount = calls;

    act(() => {
      void result.current.actions.reload();
      void result.current.actions.reload();
    });

    await waitFor(() => expect(result.current.pendingActions.has("dashboard-reload")).toBe(true));
    expect(calls).toBe(callsAfterMount + 1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.pendingActions.has("dashboard-reload")).toBe(false));
    expect(result.current.toasts.at(-1)?.tone).toBe("success");
  });

  it("reload: serverio klaida praneša toast'u, o ne tik viršutine refreshError juosta", async () => {
    vi.mocked(api.fetchDashboard)
      .mockResolvedValueOnce(dashboard(oneWorker))
      .mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useDashboardController());
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());

    await act(async () => {
      await result.current.actions.reload();
    });

    expect(result.current.refreshError).toContain("network down");
    const toast = result.current.toasts.at(-1);
    expect(toast?.tone).toBe("error");
    expect(toast?.message).toContain("network down");
    expect(result.current.pendingActions.has("dashboard-reload")).toBe(false);
  });
});
