import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OptimizationCandidate } from "../../../../model/types";
import { OptimizationCandidatesList } from "../../../../view/components/tokens/OptimizationCandidatesList";

const candidate: OptimizationCandidate = {
  taskId: "700-a-02-child",
  familyKey: "700",
  taskTokens: 1000,
  groupMedianTokens: 100,
  multiplier: 10,
  reasonHint: "daug repair ciklų (3)",
};

describe("OptimizationCandidatesList", () => {
  it("shows an explanatory empty state when there are no candidates", () => {
    render(<OptimizationCandidatesList candidates={[]} />);
    expect(screen.getByText(/within their family baseline/)).toBeInTheDocument();
  });

  it("renders one row per candidate with its reason hint and multiplier", () => {
    render(<OptimizationCandidatesList candidates={[candidate]} />);
    expect(screen.getByText("700-a-02-child")).toBeInTheDocument();
    expect(screen.getByText("daug repair ciklų (3)")).toBeInTheDocument();
    expect(screen.getByText("10.0×")).toBeInTheDocument();
  });

  it("caps rendered rows and notes how many candidates were truncated", () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({ ...candidate, taskId: `t-${index}` }));
    render(<OptimizationCandidatesList candidates={candidates} />);
    expect(screen.getAllByRole("row")).toHaveLength(26); // header + 25 rows
    expect(screen.getByText(/Showing 25 of 30 candidates/)).toBeInTheDocument();
  });
});
