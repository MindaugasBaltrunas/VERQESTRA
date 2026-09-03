import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LearningPanel } from "../../../../view/components/dashboard/LearningPanel";
import type { UiControlPlaneData, UiLearningRecommendation } from "../../../../model/types";

const summary: UiControlPlaneData["learning_summary"] = {
  records: 3,
  by_type: { policy_recommendation: 2 },
  pending_recommendations: 1,
  approved_recommendations: 1,
  rejected_recommendations: 0,
};

const pending: UiLearningRecommendation = {
  id: "rec-1",
  status: "pending",
  summary: "Increase max files per task",
  labels: ["enforcement"],
  evidence: ["task 42 split unnecessarily"],
  actions: ["approve", "reject"],
};

const approved: UiLearningRecommendation = {
  id: "rec-2",
  status: "approved",
  summary: "Already applied recommendation",
  labels: [],
  evidence: [],
  actions: [],
};

describe("LearningPanel", () => {
  it("renders the summary counts and recommendation content", () => {
    render(
      <LearningPanel
        summary={summary}
        recommendations={[pending, approved]}
        onApprove={vi.fn().mockResolvedValue(undefined)}
        onReject={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("heading", { name: "Recommendation inbox" })).toBeInTheDocument();
    expect(screen.getByText("Increase max files per task")).toBeInTheDocument();
    expect(screen.getByText("task 42 split unnecessarily")).toBeInTheDocument();
  });

  it("wires approve/reject buttons for pending recommendations only", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(
      <LearningPanel
        summary={summary}
        recommendations={[pending, approved]}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    // Only the single pending recommendation exposes action buttons.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledWith("rec-1");

    // decide() užrakina abu mygtukus (busyId) iki approve promise resolve —
    // sinchroniškas antras click būtų ignoruojamas, todėl palaukiam atrakinimo.
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("rec-1");
  });

  it("shows an empty state when there are no recommendations", () => {
    render(
      <LearningPanel
        summary={{ ...summary, pending_recommendations: 0, approved_recommendations: 0, records: 0 }}
        recommendations={[]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByText("All recommendations reviewed")).toBeInTheDocument();
  });
});
