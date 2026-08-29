import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PolicyProposalsPanel } from "./App";
import { decidePolicyProposal, fetchPolicyProposals } from "./model/api";
import type { PolicyProposal, PolicyProposalStatus, ResolvedProposal } from "./model/types";

vi.mock("./model/api", () => ({
  fetchPolicyProposals: vi.fn().mockResolvedValue({ proposals: [] }),
  decidePolicyProposal: vi.fn(),
}));

const fetchMock = vi.mocked(fetchPolicyProposals);
const decideMock = vi.mocked(decidePolicyProposal);

function proposal(overrides: Partial<PolicyProposal> = {}): PolicyProposal {
  return {
    policy_file: "vq/config/coding-principles.json",
    setting_id: "dry",
    old_value: "off",
    requested_value: "on",
    reason: "dubliavimas kartojasi",
    timestamp: "2026-08-29T10:00:00.000Z",
    routing: "queue",
    ...overrides,
  };
}

function resolved(status: PolicyProposalStatus, overrides: Partial<PolicyProposal> = {}): ResolvedProposal {
  return { proposal: proposal(overrides), status, history: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ proposals: [] });
});

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

  for (const status of ["pending", "approved"] as const) {
    it(`asks for confirmation before cancelling a '${status}' proposal`, async () => {
      fetchMock.mockResolvedValue({ proposals: [resolved(status)] });
      decideMock.mockResolvedValue({ proposals: [resolved("cancelled")] });
      render(<PolicyProposalsPanel />);

      const arm = await screen.findByRole("button", { name: "Cancel proposal" });

      // Pirmas paspaudimas TIK apginkluoja: kol patvirtinimo nėra, serveris nekviečiamas.
      fireEvent.click(arm);
      expect(decideMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Cancel proposal" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Confirm: Cancel proposal" }));

      await waitFor(() => {
        expect(decideMock).toHaveBeenCalledWith("cancel", {
          policy_file: "vq/config/coding-principles.json",
          setting_id: "dry",
          reason: "dubliavimas kartojasi",
        });
      });
    });
  }

  it("disarms the confirmation without cancelling when 'Keep proposal' is chosen", async () => {
    fetchMock.mockResolvedValue({ proposals: [resolved("pending")] });
    render(<PolicyProposalsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel proposal" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep proposal" }));

    expect(decideMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  /**
   * Tapatybė yra trejetas, ne `setting_id`: apginkluota viena eilutė neturi apginkluoti antros,
   * laukiančios tam pačiam nustatymui.
   */
  it("arms only the proposal whose cancel button was pressed", async () => {
    fetchMock.mockResolvedValue({
      proposals: [
        resolved("pending", { timestamp: "2026-08-29T10:00:00.000Z" }),
        resolved("pending", { timestamp: "2026-08-29T11:00:00.000Z" }),
      ],
    });
    render(<PolicyProposalsPanel />);

    const armButtons = await screen.findAllByRole("button", { name: "Cancel proposal" });
    expect(armButtons).toHaveLength(2);
    fireEvent.click(armButtons[0]!);

    expect(screen.getAllByRole("button", { name: "Confirm: Cancel proposal" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel proposal" })).toHaveLength(1);
  });

  it("moves a cancelled proposal into the history tab with a 'cancelled' badge", async () => {
    fetchMock.mockResolvedValue({
      proposals: [resolved("cancelled"), resolved("pending", { setting_id: "yagni" })],
    });
    render(<PolicyProposalsPanel />);

    // Atšauktas pasiūlymas iš „Needs action" dingsta — jo nebėra ir kiekyje.
    expect(await screen.findByRole("button", { name: "Needs action 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change history 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "yagni" })).toBeInTheDocument();
    expect(screen.queryByText("cancelled")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change history 1" }));

    expect(screen.getByText("cancelled")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "dry" })).toBeInTheDocument();
    // Galutinė būsena neturi veiksmų: atšaukto pasiūlymo nebeatšauksi antrą kartą.
    expect(screen.queryByRole("button", { name: "Cancel proposal" })).not.toBeInTheDocument();
  });
});
