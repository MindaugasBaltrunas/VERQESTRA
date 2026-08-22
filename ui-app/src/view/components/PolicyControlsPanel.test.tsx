import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UiPolicyGroup } from "../../model/types";
import { PolicyControlsPanel } from "./PolicyControlsPanel";

const groups: UiPolicyGroup[] = [
  {
    group: "architecture-style",
    label: "Architektūra",
    controls: [
      {
        id: "max_retries",
        label: "Maksimalūs bandymai",
        value: 3,
        source: "policy.json",
        editable: true,
        route: "/api/policies/runtime/proposals",
      },
      {
        id: "strict_mode",
        label: "Griežtas režimas",
        value: true,
        source: "policy.json",
        editable: true,
        route: "/api/policies/runtime/proposals",
        allowed_values: ["true", "false"],
      },
    ],
  },
];

describe("PolicyControlsPanel", () => {
  it("filters policies by search and can clear the result", () => {
    render(<PolicyControlsPanel groups={groups} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search policies" }), {
      target: { value: "missing-policy" },
    });
    expect(screen.getByText("No policies match this view")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Maksimalūs bandymai")).toBeInTheDocument();
  });

  it("preserves numeric proposal values as numbers", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Propose change" })[0]);
    fireEvent.change(screen.getByLabelText("Maksimalūs bandymai new value"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Maksimalūs bandymai change reason"), {
      target: { value: "Didesnė tolerancija" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onPropose).toHaveBeenCalledWith(
        "/api/policies/runtime/proposals",
        "max_retries",
        7,
        "Didesnė tolerancija",
      );
    });
  });

  it("preserves boolean proposal values as booleans", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Propose change" })[1]);
    fireEvent.change(screen.getByLabelText("Griežtas režimas new value"), { target: { value: "false" } });
    fireEvent.change(screen.getByLabelText("Griežtas režimas change reason"), {
      target: { value: "Laikinas pakeitimas" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPropose).toHaveBeenCalledWith(
      "/api/policies/runtime/proposals",
      "strict_mode",
      false,
      "Laikinas pakeitimas",
    ));
  });
});
