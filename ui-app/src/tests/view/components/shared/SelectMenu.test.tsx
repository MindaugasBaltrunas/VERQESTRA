import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption } from "../../../../view/components/shared/SelectMenu";

const OPTIONS: SelectMenuOption[] = [
  { value: "warn", label: "Warn" },
  { value: "block", label: "Block", tag: "Recommended" },
  { value: "advisory", label: "Advisory" },
];

function setup(overrides: Partial<Parameters<typeof SelectMenu>[0]> = {}) {
  const onChange = vi.fn();
  const props = {
    id: "strictness",
    value: "warn",
    onChange,
    options: OPTIONS,
    "aria-label": "Strictness",
    ...overrides,
  };
  render(<SelectMenu {...props} />);
  return { onChange };
}

/**
 * Trigger'io stačiakampis jsdom'e visada nulinis, tad pozicionavimas be šito neturėtų ką matuoti.
 * Reikšmės imituoja tikrą lauką: 200×40 px, `top: 100`, langas 1024×768.
 */
function stubTriggerRect(trigger: HTMLElement, rect: Partial<DOMRect>): void {
  const full = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    ...full,
    toJSON: () => full,
  } as DOMRect);
}

describe("SelectMenu", () => {
  it("is closed by default and opens on trigger click, exposing a listbox of options", () => {
    setup();
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selects an option with the mouse and closes the popover", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

    fireEvent.click(screen.getByRole("option", { name: /Block/ }));

    expect(onChange).toHaveBeenCalledWith("block");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("navigates and selects with the keyboard", () => {
    const { onChange } = setup();
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("advisory");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // Klaviatūra atidaro TIK per Enter/Space/rodykles: `fireEvent.keyDown` sąmoningai nesiunčia
  // click'o, tad šie testai tikrina patį `onKeyDown` kelią, o ne naršyklės Enter->click elgesį.
  it.each(["Enter", " ", "ArrowDown", "ArrowUp"])("opens from the trigger with %j", (key) => {
    setup();
    const trigger = screen.getByRole("combobox", { name: "Strictness" });

    trigger.focus();
    fireEvent.keyDown(trigger, { key });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("opens at the selected option, not at the first one", () => {
    setup({ value: "advisory" });
    const trigger = screen.getByRole("combobox", { name: "Strictness" });

    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(trigger).toHaveAttribute("aria-activedescendant", "strictness-listbox-option-2");
  });

  it("moves focus to the listbox when opened so arrow keys reach it", () => {
    setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

    expect(screen.getByRole("listbox")).toHaveFocus();
  });

  it("closes on Escape without changing the value and returns focus to the trigger", () => {
    const { onChange } = setup();
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  // Tab uždaro ir GRĄŽINA fokusą: sąrašas gyvena portale dokumento gale, tad be grąžinimo kitas
  // Tab vestų į puslapio pabaigą, o ne į kitą formos lauką.
  it("closes on Tab and hands focus back to the trigger", () => {
    const { onChange } = setup();
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Tab" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps aria-expanded in step with the open state through open, close and reopen", () => {
    setup();
    const trigger = screen.getByRole("combobox", { name: "Strictness" });

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("exposes combobox and listbox ARIA attributes for the current selection", () => {
    setup({ value: "block" });
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-controls", "strictness-listbox");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-activedescendant", "strictness-listbox-option-1");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[2]).toHaveAttribute("aria-selected", "false");
  });

  // Portale sąrašas praranda kontekstą, iš kurio kitaip pasiimtų vardą: `aria-label` keliauja
  // kartu, kad ekrano skaitytuvas skelbtų, KURIS laukas atsidarė.
  it("names the portalled listbox with the same label as the trigger", () => {
    setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

    expect(screen.getByRole("listbox", { name: "Strictness" })).toBeInTheDocument();
  });

  it("closes on outside click without changing the value", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // Sąrašas yra `<body>` vaikas, ne šaknies: be atskiros patikros paspaudimas ant paties varianto
  // atrodytų kaip išorinis ir uždarytų popover'į prieš pat commit'ą.
  it("does not treat a press inside the portalled panel as an outside click", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

    const option = screen.getByRole("option", { name: /Block/ });
    fireEvent.mouseDown(option);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("block");
  });

  it("does not open when disabled", () => {
    setup({ disabled: true });
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  describe("popover'is neapkerpamas ir seka trigger'į", () => {
    // Šitas testas saugo tikslią 2026-08-29 regresijos priežastį: `position: absolute` sąrašas
    // gyveno kortelėje, ir kortelės `overflow` jį nukirpdavo. Portalas išveda jį iš KIEKVIENO
    // protėvio, tad tikrinama būtent tėvystė, o ne stiliaus eilutė.
    it("renders the panel outside a clipping ancestor, as a direct child of body", () => {
      const onChange = vi.fn();
      render(
        <div className="card" style={{ overflow: "hidden", height: 40 }}>
          <SelectMenu id="strictness" value="warn" onChange={onChange} options={OPTIONS} aria-label="Strictness" />
        </div>,
      );

      fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

      const listbox = screen.getByRole("listbox");
      expect(listbox.closest(".card")).toBeNull();
      expect(listbox.parentElement).toBe(document.body);
    });

    it("positions the panel below the trigger from its measured rect", () => {
      setup();
      const trigger = screen.getByRole("combobox", { name: "Strictness" });
      stubTriggerRect(trigger, { top: 100, bottom: 140, left: 40, right: 240, width: 200, height: 40 });

      fireEvent.click(trigger);

      // `position: fixed` gyvena `dashboard.css` (jsdom stilių nekrauna), o čia tikrinamos pačios
      // koordinatės — jos ir yra tai, ką skaičiuoja komponentas.
      const listbox = screen.getByRole("listbox");
      expect(listbox.style.top).toBe("146px");
      expect(listbox.style.left).toBe("40px");
      expect(listbox.style.minWidth).toBe("200px");
      expect(listbox.style.bottom).toBe("");
      expect(listbox).not.toHaveClass("select-menu-panel-above");
    });

    // Lange (768 px) trigger'iui stovint 700 px aukštyje žemiau lieka ~54 px — sąrašas, atsidaręs
    // žemyn, prasidėtų už ekrano ribos, ir pirmas variantas būtų nepasiekiamas.
    it("flips above the trigger when there is no room below", () => {
      setup();
      const trigger = screen.getByRole("combobox", { name: "Strictness" });
      stubTriggerRect(trigger, { top: 700, bottom: 740, left: 40, right: 240, width: 200, height: 40 });

      fireEvent.click(trigger);

      const listbox = screen.getByRole("listbox");
      expect(listbox.style.bottom).toBe("74px");
      expect(listbox.style.top).toBe("");
      expect(listbox).toHaveClass("select-menu-panel-above");
    });

    it("keeps the panel inside the viewport when the trigger sits at the right edge", () => {
      setup();
      const trigger = screen.getByRole("combobox", { name: "Strictness" });
      stubTriggerRect(trigger, { top: 100, bottom: 140, left: 900, right: 1100, width: 200, height: 40 });

      fireEvent.click(trigger);

      // 1024 - 200 - 8 = 816: sąrašas pastumiamas kairėn, kad tilptų, o ne išlįstų per kraštą.
      expect(screen.getByRole("listbox").style.left).toBe("816px");
    });

    it("closes when the page scrolls, because a fixed panel no longer tracks the trigger", () => {
      const { onChange } = setup();
      fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

      fireEvent.scroll(document);

      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("stays open while the list itself is scrolled", () => {
      setup();
      fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

      fireEvent.scroll(screen.getByRole("listbox"));

      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("closes when the window is resized", () => {
      setup();
      fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));

      fireEvent.resize(window);

      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});
