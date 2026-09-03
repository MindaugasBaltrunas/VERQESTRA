import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AggregateRow } from "../../../../model/tokenUsageViewModel";
import { TaskConcentrationChart } from "../../../../view/components/tokens/TaskConcentrationChart";

function row(key: string, totalTokens: number): AggregateRow {
  return {
    key,
    records: 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens,
  };
}

describe("TaskConcentrationChart", () => {
  it("ranks tasks and shows their cumulative concentration", () => {
    render(<TaskConcentrationChart rows={[row("small", 25), row("large", 75)]} />);
    expect(screen.getByText("large")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("Σ 100%")).toBeInTheDocument();
  });

  it("supports task drill-down", () => {
    const onSelectTask = vi.fn();
    render(<TaskConcentrationChart rows={[row("task-1", 100)]} onSelectTask={onSelectTask} />);
    fireEvent.click(screen.getByRole("button", { name: "task-1" }));
    expect(onSelectTask).toHaveBeenCalledWith("task-1");
  });
});
