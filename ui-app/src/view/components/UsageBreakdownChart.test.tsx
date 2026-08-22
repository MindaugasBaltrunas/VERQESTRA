import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AggregateRow } from "../../model/tokenUsageViewModel";
import { UsageBreakdownChart } from "./UsageBreakdownChart";

function row(totalTokens: number, records = 1): AggregateRow {
  return {
    key: "fastpath",
    records,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens,
  };
}

describe("UsageBreakdownChart", () => {
  it("distinguishes zero-token activity from missing data", () => {
    render(<UsageBreakdownChart rows={[row(0, 12)]} title="Tokenai pagal fazę" />);
    expect(screen.getByText("12 activity records exist, but none report token usage.")).toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("renders a localized percentage for token-bearing rows", () => {
    render(<UsageBreakdownChart rows={[row(100)]} title="Tokenai pagal fazę" />);
    expect(screen.getByText(/100\s*%/)).toBeInTheDocument();
  });

  it("exposes an accessible drill-down action", () => {
    const onSelectKey = vi.fn();
    render(<UsageBreakdownChart rows={[row(100)]} title="Models" onSelectKey={onSelectKey} />);
    fireEvent.click(screen.getByRole("button", { name: "fastpath" }));
    expect(onSelectKey).toHaveBeenCalledWith("fastpath");
  });
});
