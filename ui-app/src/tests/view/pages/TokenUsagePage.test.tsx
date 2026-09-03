import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { TokenUsagePage } from "../../../view/pages/TokenUsagePage";
import * as api from "../../../model/api";
import type { TokenAnalyticsResponse, TokenUsageRecord } from "../../../model/types";

vi.mock("../../../model/api", () => ({
  fetchTokenUsage: vi.fn(),
  fetchTokenAnalytics: vi.fn(),
  getUiToken: vi.fn().mockReturnValue(""),
}));

const emptyResponse = {
  records: [] as TokenUsageRecord[],
};

const emptyAnalyticsResponse: TokenAnalyticsResponse = { groups: [], candidates: [], history: [] };

const noop = () => undefined;

afterEach(() => {
  vi.mocked(api.fetchTokenUsage).mockReset();
  vi.mocked(api.fetchTokenAnalytics).mockReset();
});

describe("TokenUsagePage", () => {
  it("renders the empty state when there are no records", async () => {
    vi.mocked(api.fetchTokenUsage).mockResolvedValue(emptyResponse);
    vi.mocked(api.fetchTokenAnalytics).mockResolvedValue(emptyAnalyticsResponse);

    render(<TokenUsagePage activeRoute="analytics" onNavigate={noop} />);

    await waitFor(() => {
      expect(screen.getByText(/No token usage data/)).toBeInTheDocument();
    });
  });

  it("renders the error state with a retry button when the fetch is rejected", async () => {
    vi.mocked(api.fetchTokenUsage).mockRejectedValue(new Error("boom"));
    vi.mocked(api.fetchTokenAnalytics).mockResolvedValue(emptyAnalyticsResponse);

    render(<TokenUsagePage activeRoute="analytics" onNavigate={noop} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("renders non-zero totals and a table row given sample records", async () => {
    const records: TokenUsageRecord[] = [
      {
        ts: "2026-06-01T10:00:00.000Z",
        phase: "dispatch",
        task_id: "task-alpha",
        model: "claude-opus",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        total_cost_usd: 1.23,
      },
      {
        ts: "2026-06-02T10:00:00.000Z",
        phase: "diagnose",
        task_id: "task-beta",
        model: "claude-haiku",
        input_tokens: 40,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        total_cost_usd: 0.5,
      },
    ];
    vi.mocked(api.fetchTokenUsage).mockResolvedValue({ records });
    vi.mocked(api.fetchTokenAnalytics).mockResolvedValue(emptyAnalyticsResponse);

    render(<TokenUsagePage activeRoute="analytics" onNavigate={noop} />);

    await waitFor(() => {
      expect(screen.getByText("140")).toBeInTheDocument();
    });
    const taskTable = screen.getByRole("table", {
      name: "Task token usage for selected filters",
    });
    const taskPanel = screen.getByRole("region", {
      name: "Top token-consuming tasks",
    });
    const overviewGrid = document.querySelector(".token-overview-grid");
    expect(overviewGrid).not.toContainElement(taskPanel);
    expect(within(taskTable).getByText("task-alpha")).toBeInTheDocument();
    expect(within(taskTable).getByText("task-beta")).toBeInTheDocument();
  });

  it("keeps the table's task count aligned with the KPI and explains records with no task_id", async () => {
    const records: TokenUsageRecord[] = [
      {
        ts: "2026-06-01T10:00:00.000Z",
        phase: "dispatch",
        task_id: "task-alpha",
        model: "claude-opus",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
      {
        ts: "2026-06-02T10:00:00.000Z",
        phase: "diagnose",
        task_id: "task-beta",
        model: "claude-haiku",
        input_tokens: 40,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      {
        ts: "2026-06-03T10:00:00.000Z",
        phase: "diagnose",
        task_id: "",
        model: "claude-haiku",
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      {
        ts: "2026-06-04T10:00:00.000Z",
        phase: "diagnose",
        task_id: "   ",
        model: "claude-haiku",
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ];
    vi.mocked(api.fetchTokenUsage).mockResolvedValue({ records });
    vi.mocked(api.fetchTokenAnalytics).mockResolvedValue(emptyAnalyticsResponse);

    render(<TokenUsagePage activeRoute="analytics" onNavigate={noop} />);

    const taskPanel = await screen.findByRole("region", { name: "Top token-consuming tasks" });
    const taskTable = screen.getByRole("table", { name: "Task token usage for selected filters" });

    expect(within(taskTable).getAllByRole("row")).toHaveLength(3); // header + 2 real tasks
    expect(within(taskPanel).getByText("2 tasks")).toBeInTheDocument();

    const uniqueTasksMetric = screen.getByText("Unique tasks").closest(".metric");
    expect(uniqueTasksMetric).not.toBeNull();
    expect(within(uniqueTasksMetric as HTMLElement).getByText("2")).toBeInTheDocument();

    expect(within(taskPanel).getByText(/2 telemetry records have no assigned task \(task_id\)/)).toBeInTheDocument();
  });

  it("renders the optimization error state as an alert when the analytics fetch is rejected", async () => {
    vi.mocked(api.fetchTokenUsage).mockResolvedValue(emptyResponse);
    vi.mocked(api.fetchTokenAnalytics).mockRejectedValue(new Error("analytics down"));

    render(<TokenUsagePage activeRoute="optimization" onNavigate={noop} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("analytics down");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("renders similar-task groups and optimization candidates from the analytics endpoint", async () => {
    vi.mocked(api.fetchTokenUsage).mockResolvedValue(emptyResponse);
    vi.mocked(api.fetchTokenAnalytics).mockResolvedValue({
      groups: [
        {
          familyKey: "700",
          taskIds: ["700-a", "700-a-02-child"],
          totalTokensByTask: { "700-a": 100, "700-a-02-child": 1000 },
          totalRecords: 2,
          totalTokens: 1100,
          medianTokens: 550,
        },
      ],
      candidates: [
        {
          taskId: "700-a-02-child",
          familyKey: "700",
          taskTokens: 1000,
          groupMedianTokens: 100,
          multiplier: 10,
          reasonHint: "daug repair ciklų (3)",
        },
      ],
      history: [
        {
          generatedAt: "2026-07-19T10:00:00.000Z",
          totals: { records: 2, totalTokens: 1100, uniqueTasks: 2 },
          tokensByPhase: [{ key: "dispatch", totalTokens: 1100 }],
          tokensByModel: [{ key: "sonnet", totalTokens: 1100 }],
          tokensByDay: [{ key: "2026-07-19", totalTokens: 1100 }],
          fastPathHitRate: { preflight: 0, diagnose: 0 },
          cacheHitRate: 0.4,
          repairShare: 0.5,
          groupMedians: [{ familyKey: "700", taskCount: 2, medianTokens: 550 }],
        },
      ],
    });

    render(<TokenUsagePage activeRoute="optimization" onNavigate={noop} />);

    await waitFor(() => {
      expect(screen.getByText("Comparable task families")).toBeInTheDocument();
    });
    expect(screen.getAllByText("700").length).toBeGreaterThan(0);
    expect(screen.getByText("700-a-02-child")).toBeInTheDocument();
    expect(screen.getByText("daug repair ciklų (3)")).toBeInTheDocument();
  });
});
