import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

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

  it("closes on outside click without changing the value", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Strictness" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open when disabled", () => {
    setup({ disabled: true });
    const trigger = screen.getByRole("combobox", { name: "Strictness" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
