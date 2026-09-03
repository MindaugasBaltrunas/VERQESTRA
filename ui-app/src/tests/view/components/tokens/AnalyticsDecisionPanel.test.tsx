import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalyticsDecisionPanel } from "../../../../view/components/tokens/AnalyticsDecisionPanel";
import { computePeriodComparison, computeReworkProxyStats } from "../../../../model/tokenUsageViewModel";
import type { TokenUsageRecord } from "../../../../model/types";

function usage(overrides: Partial<TokenUsageRecord>): TokenUsageRecord {
  return {
    ts: "2026-07-01T10:00:00.000Z",
    phase: "dispatch",
    task_id: "task-1",
    model: "sonnet",
    input_tokens: 100,
    ...overrides,
  };
}

describe("AnalyticsDecisionPanel", () => {
  it("shows exact retry metrics when attempt metadata coverage is complete", () => {
    const records = [
      usage({ attempt: 1, outcome: "failed" }),
      usage({ ts: "2026-07-02T10:00:00.000Z", attempt: 2, outcome: "succeeded", input_tokens: 40 }),
    ];
    render(
      <AnalyticsDecisionPanel
        comparison={computePeriodComparison(records)}
        rework={computeReworkProxyStats(records)}
        isPartial={false}
      />,
    );
    expect(screen.getByText("Retry tokens")).toBeInTheDocument();
    expect(screen.getByText(/1 retry attempts/)).toBeInTheDocument();
    expect(screen.queryByText(/not a waste metric/)).not.toBeInTheDocument();
  });

  it("discloses proxy semantics for legacy records", () => {
    const records = [usage({ phase: "diagnose" })];
    render(
      <AnalyticsDecisionPanel
        comparison={computePeriodComparison(records)}
        rework={computeReworkProxyStats(records)}
        isPartial
      />,
    );
    expect(screen.getByText("Diagnostic / rework proxy")).toBeInTheDocument();
    expect(screen.getByText(/not a waste metric/)).toBeInTheDocument();
    expect(screen.getByText("Loaded records only")).toBeInTheDocument();
  });
});
