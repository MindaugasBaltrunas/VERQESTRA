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
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onPropose).toHaveBeenCalledWith(
        "/api/policies/runtime/proposals",
        "max_retries",
        7,
      );
    });
  });

  // Priežasties lauko nebėra (2026-08-28): forma yra reikšmės pasirinkimas ir Send/Cancel, o Send
  // niekada nebūna užrakintas dėl neužpildyto teksto. Tikrinama ir tai, kad laukas dingo, ir tai,
  // kad pasiūlymas nusiunčiamas jo neužpildžius — kitaip lauką būtų galima grąžinti nepastebėtai.
  //
  // Reikšmė čia keičiama sąmoningai: nuo 2026-09-01 Send užrakina NEPAKEISTA reikšmė, ir tik ji.
  // Be pakeitimo testas tikrintų ne tekstinio lauko nebuvimą, o no-op rakinimą — du skirtingi
  // dalykai viename teiginyje.
  it("submits without a change reason field in the form", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(0);
    expect(screen.queryByText("Change reason")).toBeNull();
    expect(screen.queryByText("(required)")).toBeNull();
    expect(screen.queryByText("Enter a reason for the change")).toBeNull();
    expect(document.querySelector(".policy-change-form textarea")).toBeNull();

    fireEvent.change(screen.getByLabelText("Maksimalūs bandymai New value"), { target: { value: "5" } });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() => expect(onPropose).toHaveBeenCalledWith(
      "/api/policies/runtime/proposals",
      "max_retries",
      5,
    ));
    // Sėkmingas siuntimas uždaro formą — kortelė vėl siūlo ją atidaryti.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Propose change" }).length).toBe(3));
  });

  // NE-OP PASIŪLYMAS (2026-08-31 UI auditas, P1). Forma atsidaro ties rekomenduojama reikšme, o ji
  // dažnai jau yra dabartinė: peržiūra rodė „advisory → advisory", Send liko aktyvus, ir serveris
  // (task 103) tokį pasiūlymą atmesdavo 4xx — klaidos toast'as ten, kur teisingas atsakymas yra
  // „nėra ko siųsti". Tikrinamas ir grįžimas atgal: rakinimas turi sekti reikšmę, ne pirmą įspūdį.
  it("locks Send while the chosen value still equals the current one", () => {
    render(<PolicyControlsPanel groups={groups} onPropose={vi.fn()} />);

    openForm(0);
    const send = screen.getByRole("button", { name: "Send" });
    const field = screen.getByLabelText("Maksimalūs bandymai New value");
    expect(send).toBeDisabled();
    const hint = screen.getByText("Choose a different value");
    expect(hint).toBeInTheDocument();
    // Priežastis pasiekiama ir ekrano skaitytuvui, ne tik akiai.
    expect(send).toHaveAttribute("aria-describedby", hint.id);

    fireEvent.change(field, { target: { value: "7" } });
    expect(send).toBeEnabled();
    expect(screen.queryByText("Choose a different value")).toBeNull();
    expect(send).not.toHaveAttribute("aria-describedby");

    fireEvent.change(field, { target: { value: "3" } });
    expect(send).toBeDisabled();
    expect(screen.getByText("Choose a different value")).toBeInTheDocument();
  });

  // Palyginimas eina PO `parseFormValue`: dropdown'as duoda `"true"`, o dabartinė reikšmė yra
  // `true`. Lyginant neapdorotą eilutę su boolean'u no-op niekada nesutaptų, ir vartas praeitų
  // tuščias būtent ten, kur jis labiausiai reikalingas — dviejų variantų sąraše.
  it("treats a string form value as unchanged when it parses to the current boolean", () => {
    render(<PolicyControlsPanel groups={groups} onPropose={vi.fn()} />);

    openForm(1);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.click(screen.getByRole("combobox", { name: "Griežtas režimas New value" }));
    fireEvent.click(screen.getByRole("option", { name: "No" }));
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  // Neparsinama reikšmė NĖRA no-op: skaitiniam nustatymui įvestas tekstas yra klaida, ir ją turi
  // parodyti siuntimo kelias (`policy-form-error`), o ne tyliai užrakintas mygtukas su
  // paaiškinimu, kuris meluoja apie priežastį.
  it("keeps Send active for an unparseable value so the error path can report it", () => {
    render(<PolicyControlsPanel groups={groups} onPropose={vi.fn()} />);

    openForm(0);
    fireEvent.change(screen.getByLabelText("Maksimalūs bandymai New value"), { target: { value: "abc" } });

    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByText("Choose a different value")).toBeNull();
  });

  it("sends a real boolean when the value is picked from the dropdown", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(1);
    fireEvent.click(screen.getByRole("combobox", { name: "Griežtas režimas New value" }));
    fireEvent.click(screen.getByRole("option", { name: "No" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPropose).toHaveBeenCalledWith(
      "/api/policies/runtime/proposals",
      "strict_mode",
      false,
    ));
  });

  // Klaviatūros kelias tikrinamas FORMOS kontekste, ne izoliuotai: būtent čia reikšmė pereina
  // `parseFormValue`, ir būtent čia matyti, ar `onPropose` gauna tikrą `boolean`, ar eilutę
  // `"false"`. Izoliuotas SelectMenu testas to parodyti negali — jis mato tik `onChange("false")`.
  it("picks a boolean value with the keyboard and sends it as a real boolean, not a string", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(1);
    const trigger = screen.getByRole("combobox", { name: "Griežtas režimas New value" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPropose).toHaveBeenCalledTimes(1));
    const [, , requestedValue] = onPropose.mock.calls[0]!;
    expect(typeof requestedValue).toBe("boolean");
    expect(requestedValue).toBe(false);
  });

  // Kortelė yra apribotas dėklas: kol popover'is buvo `position: absolute` jos viduje, bet kuris
  // `overflow` protėvis jį nukirpdavo. Tikrinama tėvystė, nes tik ji to nebeleidžia.
  it("opens the dropdown outside the policy card so no ancestor can clip it", () => {
    render(<PolicyControlsPanel groups={groups} onPropose={vi.fn()} />);

    openForm(2);
    fireEvent.click(screen.getByRole("combobox", { name: "Griežtumas New value" }));

    const listbox = screen.getByRole("listbox");
    expect(listbox.closest(".policy-control-card")).toBeNull();
    expect(listbox.closest(".policy-change-form")).toBeNull();
    expect(listbox.parentElement).toBe(document.body);
  });

  it("closes the dropdown on Escape inside the card and keeps the form open", () => {
    render(<PolicyControlsPanel groups={groups} onPropose={vi.fn()} />);

    openForm(2);
    const trigger = screen.getByRole("combobox", { name: "Griežtumas New value" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  // Stilių sąrašas ateina iš serverio (`allowed_values`), o ne iš naršyklėje įrašytos kopijos:
  // iki 2026-09-02 čia gyveno keturi įrašai su domain'ui nežinomu `modular_monolith`.
  it("offers exactly the server-provided architecture styles for the style control", () => {
    const styleGroup: UiPolicyGroup[] = [{
      group: "architecture-style",
      label: "Architektūra",
      controls: [{
        id: "style",
        label: "Architektūros stilius",
        value: "layered",
        source: "vq/architecture/architecture-style.json",
        editable: true,
        route: "/api/policies/architecture-style/set",
        allowed_values: ["layered", "hexagonal", "pipeline"],
      }],
    }];
    render(<PolicyControlsPanel groups={styleGroup} onPropose={vi.fn()} />);

    openForm(0);
    fireEvent.click(screen.getByRole("combobox", { name: "Architektūros stilius New value" }));
    // Dabartinė reikšmė gauna „Recommended" ženklelį (rekomendacijos `style` neturi, tad ji ir yra
    // dabartinė) — todėl lyginami prieinami vardai, ne grynas tekstas.
    expect(screen.getAllByRole("option").length).toBe(3);
    expect(screen.getByRole("option", { name: "layered Recommended" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "hexagonal" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "pipeline" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "modular_monolith" })).toBeNull();
  });

  it("hands the value chosen in the dropdown to onPropose and tags the recommended option", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<PolicyControlsPanel groups={groups} onPropose={onPropose} />);

    openForm(2);
    fireEvent.click(screen.getByRole("combobox", { name: "Griežtumas New value" }));
    // Rekomendacija yra varianto ženklelis sąraše, ne sakinys kortelėje.
    expect(screen.getByRole("option", { name: "warn Recommended" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "block" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPropose).toHaveBeenCalledWith(
      "/api/policies/runtime/proposals",
      "strictness",
      "block",
    ));
  });
});
