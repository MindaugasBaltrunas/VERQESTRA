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
      {
        id: "strictness",
        label: "Griežtumas",
        value: "advisory",
        source: "policy.json",
        editable: true,
        route: "/api/policies/runtime/proposals",
        allowed_values: ["advisory", "warn", "block"],
      },
    ],
  },
];

/** Formos atidarymas per kortelės veiksmą — indeksas seka `groups.controls` tvarką. */
function openForm(index: number): void {
  fireEvent.click(screen.getAllByRole("button", { name: "Propose change" })[index]!);
}

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

  // Kortelė nebeaiškina — ji rodo dabartinę reikšmę ir atiduoda pasirinkimą dropdown'ui. Trys
  // buvę komentarų šaltiniai (kodų juostelė, „Recommended" sakiniai, „?" popover'is) čia
  // tikrinami po vieną, nes kiekvienas jų sugrįžtų atskirai.
  it("shows the current value without the explanatory comment blocks", () => {
    render(<PolicyControlsPanel groups={groups} onPropose={vi.fn()} />);

    expect(screen.getAllByText("Current value").length).toBe(3);
    expect(screen.queryByText("Available values")).toBeNull();
    expect(screen.queryByText("Recommended")).toBeNull();
    expect(screen.queryByText("Balanced best-practice default for quality and safe delivery.")).toBeNull();
    expect(
      screen.queryByText("Keep the current value unless a planned architecture change requires otherwise."),
    ).toBeNull();
    expect(screen.queryByText("Enter a numeric limit.")).toBeNull();
    expect(screen.queryByText("?")).toBeNull();
    // Boolean dabartinė reikšmė rašoma tais pačiais žodžiais kaip ir dropdown'o variantas.
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("renders a pending proposal as a current -> new row", () => {
    const pending: UiPolicyGroup[] = [{
      ...groups[0]!,
      controls: [{ ...groups[0]!.controls[0]!, pending_proposal: "9", pending_proposal_count: 2 }],
    }];
    render(<PolicyControlsPanel groups={pending} />);

    expect(screen.getByText("Current value")).toBeInTheDocument();
    expect(screen.getByText("Pending proposal")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("2 proposals for this setting; the newest is shown.")).toBeInTheDocument();
  });

  it("preserves numeric proposal values as numbers", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(0);
    // Prieinamas vardas tebeturi valdiklio vardą, tik dabar jį duoda MATOMOS etiketės
    // (`aria-labelledby`), o ne nematomas `aria-label`: placeholder dingdavo vos pradėjus rašyti.
    fireEvent.change(screen.getByLabelText("Maksimalūs bandymai New value"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(/Maksimalūs bandymai Change reason/), {
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

  it("sends a real boolean when the value is picked from the dropdown", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(1);
    fireEvent.click(screen.getByRole("combobox", { name: "Griežtas režimas New value" }));
    fireEvent.click(screen.getByRole("option", { name: "No" }));
    fireEvent.change(screen.getByLabelText(/Griežtas režimas Change reason/), {
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

  it("hands the value chosen in the dropdown to onPropose and tags the recommended option", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(2);
    fireEvent.click(screen.getByRole("combobox", { name: "Griežtumas New value" }));
    // Rekomendacija yra varianto ženklelis sąraše, ne sakinys kortelėje.
    expect(screen.getByRole("option", { name: "warn Recommended" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "block" }));
    fireEvent.change(screen.getByLabelText(/Griežtumas Change reason/), {
      target: { value: "Griežtinam" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPropose).toHaveBeenCalledWith(
      "/api/policies/runtime/proposals",
      "strictness",
      "block",
      "Griežtinam",
    ));
  });
});
