import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildFailureCsv } from "../../../model/failureCsv";
import { ReliabilityPage } from "../../../view/pages/ReliabilityPage";

vi.mock("../../../model/api", () => ({
  fetchReliabilityAnalytics: vi.fn().mockResolvedValue({
    generatedAt: "2026-07-30T10:00:00Z",
    coverage: { gitSinceDays: 90, gitAvailable: true, taskEvents: 2, tokenRecords: 1, limitations: [] },
    files: {
      session: { touched: 3, created: 1, modified: 2, deleted: 0 },
      today: { created: 1, modified: 2, deleted: 0, commits: 1, uniqueFiles: 3 },
      week: { created: 2, modified: 4, deleted: 1, commits: 3, uniqueFiles: 7 },
      byDay: [{ date: "2026-07-30", created: 1, modified: 2, deleted: 0, commits: 1, uniqueFiles: 3 }],
      byExtension: [{ extension: ".ts", files: 3 }],
    },
    reliability: {
      failures: 16,
      fixed: 0,
      open: 16,
      fixRate: 0,
      incidentTokens: 3_200,
      repairTokens: 2_400,
      diagnosticTokens: 1_600,
      retryTokens: 800,
      cacheTokens: 400,
      byType: [{ type: "TypeScript", count: 16, fixed: 0, open: 16 }],
      byDay: [{ date: "2026-07-30", fixed: 0, open: 16, incidentTokens: 3_200, repairTokens: 2_400, diagnosticTokens: 1_600, retryTokens: 800, cacheTokens: 400 }],
      records: Array.from({ length: 16 }, (_, index) => ({
        taskId: `task-${index + 1}`,
        failedAt: `2026-07-30T09:${String(index).padStart(2, "0")}:00Z`,
        status: "open",
        type: "TypeScript",
        phase: "diagnose",
        reason: "typescript_failed",
        totalTokens: 200,
        repairTokens: 150,
        diagnosticTokens: 100,
        retryTokens: 50,
        cacheTokens: 25,
      })),
    },
  }),
}));

describe("ReliabilityPage", () => {
  it("renders file activity, failure summary, and the deterministic failure ledger", async () => {
    render(<ReliabilityPage activeRoute="reliability" onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Files this session")).toBeInTheDocument());
    expect(screen.getByText("Still unresolved")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "File activity over time" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failure and repair timeline" })).toBeInTheDocument();
    const details = screen.getByText("Failure details").closest("details");
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Failure details"));
    expect(details).toHaveAttribute("open");
    await waitFor(() => expect(screen.getByText("Collapse details")).toBeInTheDocument());
    expect(screen.getByText("task-16")).toBeInTheDocument();
    expect(screen.getAllByText("typescript_failed")).toHaveLength(15);

    fireEvent.click(screen.getByRole("button", { name: /2026-07-30 UTC; Failures: 16/ }));
    expect(screen.getByText(/2026-07-30 UTC · 16 records/)).toBeInTheDocument();
    expect(screen.getByText("Incident tokens: 3.2K")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.queryByText("task-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("task-1")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search failures"), { target: { value: "task-16" } });
    expect(screen.getByText(/1 record/)).toBeInTheDocument();
    expect(screen.getByText("task-16")).toBeInTheDocument();
    expect(screen.queryByText("task-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("exports stable CSV columns and neutralizes spreadsheet formulas", () => {
    const csv = buildFailureCsv([{
      taskId: "=unsafe",
      failedAt: "2026-07-30T09:00:00Z",
      status: "open",
      type: "TypeScript",
      phase: "diagnose",
      reason: "+formula",
      totalTokens: 200,
      repairTokens: 150,
      diagnosticTokens: 100,
      retryTokens: 50,
      cacheTokens: 25,
    }]);
    expect(csv).toContain("incident_tokens");
    expect(csv).toContain("'=unsafe");
    expect(csv).toContain("'+formula");
  });
});
