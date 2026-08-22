import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OptimizationCandidate, TaskFamilyGroup } from "../../model/types";
import { GroupComparisonChart } from "./GroupComparisonChart";

const group: TaskFamilyGroup = {
  familyKey: "700",
  taskIds: ["700-a", "700-a-02-child"],
  totalTokensByTask: { "700-a": 100, "700-a-02-child": 1000 },
  totalRecords: 2,
  totalTokens: 1100,
  medianTokens: 550,
};

const candidate: OptimizationCandidate = {
  taskId: "700-a-02-child",
  familyKey: "700",
  taskTokens: 1000,
  groupMedianTokens: 100,
  multiplier: 10,
  reasonHint: "daug repair ciklų (3)",
};

describe("GroupComparisonChart", () => {
  it("shows the empty state when there are no groups", () => {
    render(<GroupComparisonChart groups={[]} candidates={[]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders a bar per group and a candidate badge when the family has one", () => {
    render(<GroupComparisonChart groups={[group]} candidates={[candidate]} />);
    expect(screen.getByText("700")).toBeInTheDocument();
    expect(screen.getByText("⚠ 1")).toBeInTheDocument();
  });

  it("does not render a candidate badge for a family with no candidates", () => {
    render(<GroupComparisonChart groups={[group]} candidates={[]} />);
    expect(screen.queryByText(/⚠/)).not.toBeInTheDocument();
  });

  it("discloses when the comparison chart is limited to the top groups", () => {
    const groups = Array.from({ length: 21 }, (_, index) => ({
      ...group,
      familyKey: String(index),
      totalTokens: 1_000 - index,
    }));
    render(<GroupComparisonChart groups={groups} candidates={[]} />);
    expect(screen.getByText("Chart shows the top 20 of 21 groups by total token usage.")).toBeInTheDocument();
  });
});
