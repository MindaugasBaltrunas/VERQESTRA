import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AggregateRow } from "../../model/tokenUsageViewModel";
import { TopTasksTable } from "./TopTasksTable";

function row(index: number): AggregateRow {
  return {
    key: `task-${String(index).padStart(2, "0")}`,
    records: index,
    inputTokens: index * 10,
    outputTokens: index * 20,
    cacheReadTokens: index * 30,
    cacheCreationTokens: index * 5,
    totalTokens: index * 65,
  };
}

describe("TopTasksTable", () => {
  it("limits the first page and exposes accessible pagination", () => {
    render(<TopTasksTable rows={Array.from({ length: 20 }, (_, index) => row(index + 1))} />);

    expect(screen.getAllByRole("row")).toHaveLength(16);
    expect(screen.getByText("1–15 iš 20")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(screen.getByText("16–20 iš 20")).toBeInTheDocument();
  });

  it("uses keyboard-focusable buttons for sortable headers", () => {
    render(<TopTasksTable rows={[row(1), row(2)]} />);
    const tokensHeader = screen.getByRole("columnheader", { name: /Total tokens/ });
    const sortButton = within(tokensHeader).getByRole("button", { name: /Total tokens/ });

    expect(sortButton).toBeInTheDocument();
    expect(tokensHeader).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(sortButton);
    expect(tokensHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("summarizes concentration using the total-token ranking", () => {
    render(<TopTasksTable rows={[row(1), row(2)]} />);

    const overview = screen.getByLabelText("Task token summary");
    expect(within(overview).getByText("task-02")).toBeInTheDocument();
    expect(within(overview).getByText(/100\s*%/)).toBeInTheDocument();
    expect(screen.getByText("2 tasks")).toBeInTheDocument();
  });

  it("returns to the first page when the filtered row set changes", () => {
    const { rerender } = render(
      <TopTasksTable rows={Array.from({ length: 20 }, (_, index) => row(index + 1))} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("16–20 iš 20")).toBeInTheDocument();

    rerender(<TopTasksTable rows={Array.from({ length: 5 }, (_, index) => row(index + 1))} />);
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(screen.queryByText("16–20 iš 20")).not.toBeInTheDocument();
  });

  it("explains activity that did not consume tokens", () => {
    render(<TopTasksTable rows={[{ ...row(1), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 }]} />);
    expect(screen.getByText(/activity records were found, but they report no token usage/)).toBeInTheDocument();
    expect(screen.getByText("No tokens used")).toBeInTheDocument();
  });

  it("opens a task drill-down from a keyboard-focusable task button", () => {
    const onSelectTask = vi.fn();
    render(<TopTasksTable rows={[row(1)]} onSelectTask={onSelectTask} />);
    fireEvent.click(screen.getByRole("button", { name: "task-01" }));
    expect(onSelectTask).toHaveBeenCalledWith("task-01");
  });

  it("says nothing about unassigned records when there are none", () => {
    render(<TopTasksTable rows={[row(1)]} />);
    expect(screen.queryByText(/no assigned task/)).not.toBeInTheDocument();
  });

  it("surfaces unassigned records as an explicit note instead of a silent drop", () => {
    render(<TopTasksTable rows={[row(1), row(2)]} unassignedRecords={161} />);
    expect(screen.getByText(/161 telemetry records have no assigned task \(task_id\)/)).toBeInTheDocument();
  });

  it("still explains unassigned records when every record was excluded from the table", () => {
    render(<TopTasksTable rows={[]} unassignedRecords={161} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.getByText(/161 telemetry records have no assigned task \(task_id\)/)).toBeInTheDocument();
  });
});
