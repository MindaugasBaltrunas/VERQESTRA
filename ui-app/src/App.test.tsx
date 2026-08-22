import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PolicyProposalsPanel } from "./App";

vi.mock("./model/api", () => ({
  fetchPolicyProposals: vi.fn().mockResolvedValue({ proposals: [] }),
  decidePolicyProposal: vi.fn(),
}));

describe("PolicyProposalsPanel", () => {
  it("renders the heading, shows a loading state, then the empty state", async () => {
    render(<PolicyProposalsPanel />);

    expect(screen.getByRole("heading", { name: "Policy changes" })).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("No policy changes awaiting review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Change history 0" }));
    expect(screen.getByText("No policy change history")).toBeInTheDocument();
  });
});
