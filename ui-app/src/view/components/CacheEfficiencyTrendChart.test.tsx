import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TokenAnalyticsSnapshot } from "../../model/types";
import { CacheEfficiencyTrendChart } from "./CacheEfficiencyTrendChart";

function snapshot(generatedAt: string, cacheHitRate: number): TokenAnalyticsSnapshot {
  return {
    generatedAt,
    totals: { records: 1, totalTokens: 100, uniqueTasks: 1 },
    tokensByPhase: [],
    tokensByModel: [],
    tokensByDay: [],
    fastPathHitRate: { preflight: 0, diagnose: 0 },
    cacheHitRate,
    repairShare: 0,
    groupMedians: [],
  };
}

describe("CacheEfficiencyTrendChart", () => {
  it("shows the empty state when there is no history", () => {
    render(<CacheEfficiencyTrendChart history={[]} />);
    expect(screen.getByText(/No historical snapshots/)).toBeInTheDocument();
  });

  it("shows the latest cache hit rate as the headline value", () => {
    render(
      <CacheEfficiencyTrendChart
        history={[snapshot("2026-07-19T09:00:00.000Z", 0.2), snapshot("2026-07-19T10:00:00.000Z", 0.65)]}
      />,
    );
    expect(within(screen.getByText(/Cache hit rate across/).closest(".chart-panel")!).getByText("65%")).toBeInTheDocument();
  });
});
