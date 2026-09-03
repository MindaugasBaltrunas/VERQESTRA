import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OptimizationCandidate, TaskFamilyGroup } from "../../../../model/types";
import { SimilarTaskGroupsTable } from "../../../../view/components/tokens/SimilarTaskGroupsTable";

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

describe("SimilarTaskGroupsTable", () => {
  it("shows the empty state when there are no groups", () => {
    render(<SimilarTaskGroupsTable groups={[]} candidates={[]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders one row per group with the candidate count from the matching family", () => {
    render(<SimilarTaskGroupsTable groups={[group]} candidates={[candidate]} />);
    expect(screen.getByText("700")).toBeInTheDocument();
    const cells = screen.getByText("700").closest("tr")!.querySelectorAll("td");
    expect(cells[1].textContent).toBe("2"); // task count
    expect(cells[4].textContent).toBe("1"); // candidate count in this family
  });

  it("caps rendered rows and notes how many groups were truncated", () => {
    const groups = Array.from({ length: 30 }, (_, index) => ({
      ...group,
      familyKey: `${index}`,
      taskIds: [`${index}-a`],
    }));
    render(<SimilarTaskGroupsTable groups={groups} candidates={[]} />);
    expect(screen.getAllByRole("row")).toHaveLength(26); // header + 25 rows
    expect(screen.getByText(/Showing 25 of 30 groups/)).toBeInTheDocument();
  });
});
