import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../model/api";
import type { UiHumanReviewTask } from "../model/types";
import { useHumanReviewController } from "./useHumanReviewController";

// Visas tinklo sluoksnis mock'inamas: kontroleris testuojamas kaip elgsena, o ne kaip HTTP klientas
// (ta pati drausmė kaip `useDashboardController.test.ts`).
vi.mock("../model/api", () => ({
  fetchDashboard: vi.fn(),
  triageTask: vi.fn(),
}));

function task(overrides: Partial<UiHumanReviewTask> = {}): UiHumanReviewTask {
  return {
    file: "AG/tasks/human-review/0900-example.md",
    task_id: "0900-example",
    title: "Example blocked task",
    reason: "typescript failed twice",
    blocked_by: "typecheck",
    preview: "# Example blocked task",
    actions: ["approve/requeue"],
    ...overrides,
  };
}

function dashboardWith(tasks: UiHumanReviewTask[]) {
  return { controlPlane: { human_review_tasks: tasks } } as Awaited<ReturnType<typeof api.fetchDashboard>>;
}

describe("useHumanReviewController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboardWith([task()]));
  });

  it("sends one triage request for a double click, because the guard is synchronous", async () => {
    let release: (() => void) | null = null;
    vi.mocked(api.triageTask).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    const { result } = renderHook(() => useHumanReviewController());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    // Du paspaudimai TOJE PAČIOJE partijoje, be `await` tarp jų: būtent taip atrodo greitas dvigubas
    // „Patvirtinti", kai `setBusyTaskId` mygtuko dar nespėjo išjungti.
    act(() => {
      void result.current.requeue("0900-example");
      void result.current.requeue("0900-example");
    });

    expect(api.triageTask).toHaveBeenCalledTimes(1);
    expect(api.triageTask).toHaveBeenCalledWith("requeue", "0900-example");

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.busyTaskId).toBeNull());
  });

  it("unlocks the same task after the server answered, so a real retry still works", async () => {
    vi.mocked(api.triageTask).mockRejectedValueOnce(new Error("HTTP 409: task is held by an active worker lease"));

    const { result } = renderHook(() => useHumanReviewController());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    await act(async () => {
      await result.current.complete("0900-example");
    });
    // Serverio paaiškinimas lieka prie SAVO užduoties — panelė iš jo piešia kortelės klaidą.
    expect(result.current.errors["0900-example"]).toContain("held by an active worker lease");

    vi.mocked(api.triageTask).mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.complete("0900-example");
    });

    expect(api.triageTask).toHaveBeenCalledTimes(2);
  });

  it("lets two different tasks be triaged at the same time", async () => {
    vi.mocked(api.triageTask).mockImplementation(() => new Promise<void>(() => {}));

    const { result } = renderHook(() => useHumanReviewController());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => {
      void result.current.requeue("0900-a");
      void result.current.requeue("0900-b");
    });

    // Apsauga yra PER UŽDUOTĮ: ji saugo nuo dvigubo to paties sprendimo, o ne nuo darbo su eile.
    expect(api.triageTask).toHaveBeenCalledTimes(2);
  });
});
