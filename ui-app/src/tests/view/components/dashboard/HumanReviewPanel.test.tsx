import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../../model/api";
import { HumanReviewPanel } from "../../../../view/components/dashboard/HumanReviewPanel";
import type { UiHumanReviewTask } from "../../../../model/types";

// Visas tinklo sluoksnis mock'inamas: panelė testuojama kaip elgsena, o ne kaip HTTP klientas
// (tas pats principas kaip `useDashboardController.test.ts`). `fetchDashboard` grąžina dashboard'o
// snapshot'ą, iš kurio kontroleris skaito `controlPlane.human_review_tasks`, o triažas nuo task 1235
// eina per `model/api#triageTask` — vienintelį tinklo kelią, o ne per savą `fetch`.
vi.mock("../../../../model/api", () => ({
  getUiToken: () => "test-token",
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
    preview: "# Example blocked task\n\nblocked_by: typecheck\nreason: typescript failed twice",
    actions: ["approve/requeue", "edit task", "reject/keep in human-review"],
    ...overrides,
  };
}

function dashboardWith(tasks: UiHumanReviewTask[]) {
  return { controlPlane: { human_review_tasks: tasks } } as Awaited<ReturnType<typeof api.fetchDashboard>>;
}

describe("HumanReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders cards from the dashboard's human_review_tasks payload", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboardWith([task()]));

    render(<HumanReviewPanel />);

    await waitFor(() => expect(screen.getByText("Example blocked task")).toBeInTheDocument());
    expect(screen.getByText("typescript failed twice")).toBeInTheDocument();
    expect(screen.getByText(/blocked_by: typecheck/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no human-review tasks", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboardWith([]));

    render(<HumanReviewPanel />);

    await waitFor(() =>
      expect(screen.getByText("No tasks currently require a human decision.")).toBeInTheDocument(),
    );
  });

  it("requeues a task through the confirmation dialog and refetches the list", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValueOnce(dashboardWith([task()]));
    vi.mocked(api.triageTask).mockResolvedValue(undefined);

    render(<HumanReviewPanel />);
    await waitFor(() => expect(screen.getByText("Example blocked task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve / Requeue" }));
    const confirmButton = await screen.findByRole("button", { name: "Confirm: Approve / Requeue" });

    // After the action succeeds, the next dashboard poll no longer lists the task.
    vi.mocked(api.fetchDashboard).mockResolvedValueOnce(dashboardWith([]));
    fireEvent.click(confirmButton);

    await waitFor(() => expect(api.triageTask).toHaveBeenCalledWith("requeue", "0900-example"));
    await waitFor(() => expect(api.fetchDashboard).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText("No tasks currently require a human decision.")).toBeInTheDocument(),
    );
  });

  it("cancels the confirmation dialog without sending a request", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboardWith([task()]));

    render(<HumanReviewPanel />);
    await waitFor(() => expect(screen.getByText("Example blocked task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);

    expect(screen.queryByRole("button", { name: /Confirm:/ })).not.toBeInTheDocument();
    // Atšaukimas užklausos nesiunčia pagal konstrukciją: veiksmas kviečiamas tik iš patvirtinimo.
    expect(api.triageTask).not.toHaveBeenCalled();
  });

  it("shows the server error and offers a retry that resends the same action", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(dashboardWith([task()]));
    vi.mocked(api.triageTask).mockRejectedValue(
      new Error("HTTP 409: task is held by an active worker lease"),
    );

    render(<HumanReviewPanel />);
    await waitFor(() => expect(screen.getByText("Example blocked task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve / Requeue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm: Approve / Requeue" }));

    await waitFor(() =>
      expect(screen.getByText(/task is held by an active worker lease/)).toBeInTheDocument(),
    );

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);

    await waitFor(() => expect(api.triageTask).toHaveBeenCalledTimes(2));
  });
});
