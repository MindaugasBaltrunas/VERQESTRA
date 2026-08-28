import { useEffect, useRef, useState } from "react";

export type SelectMenuOption = {
  value: string;
  label: string;
  tag?: string;
};

type Props = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  disabled?: boolean;
  "aria-label"?: string;
};

/**
 * Valdomas dropdown su pilnu ARIA combobox+listbox šablonu (2026-08-28). Plikas `<select>`
 * neleidžia rodyti `tag` ženklelio prie varianto, tad trigger'is yra mygtukas, o pats
 * pasirinkimų sąrašas — atskiras popover'as, ne naršyklės nupieštas meniu.
 *
 * Uždarymo animacijos sąmoningai nėra: elementas montuojamas tik kai atidarytas, o atsidarymo
 * `@keyframes` suveikia automatiškai su pačiu montavimu — jokio papildomo state'o perėjimui
 * sekti nereikia.
 */
export function SelectMenu({ id, value, onChange, options, disabled, ...ariaProps }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const listboxId = `${id ?? "select-menu"}-listbox`;
  const activeOptionId = open && options[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  function openAt(index: number): void {
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
    setOpen(true);
  }

  function commit(index: number): void {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        openAt(selectedIndex >= 0 ? selectedIndex : 0);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        openAt(selectedIndex >= 0 ? selectedIndex : 0);
        break;
      default:
        break;
    }
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLUListElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div className="select-menu" ref={rootRef}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : 0))}
        onKeyDown={handleTriggerKeyDown}
        {...(ariaProps["aria-label"] !== undefined ? { "aria-label": ariaProps["aria-label"] } : {})}
      >
        <span className="select-menu-trigger-label">{selected?.label ?? ""}</span>
        <span className="select-menu-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul
          id={listboxId}
          className="select-menu-panel"
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={activeOptionId}
          onKeyDown={handleListKeyDown}
          ref={(node) => {
            if (node) node.focus();
          }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${listboxId}-option-${index}`}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                role="option"
                aria-selected={isSelected}
                className={index === activeIndex ? "select-menu-option active" : "select-menu-option"}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
              >
                <span className="select-menu-option-label">{option.label}</span>
                {option.tag !== undefined && <span className="select-menu-option-tag">{option.tag}</span>}
                {isSelected && <span className="select-menu-option-check" aria-hidden="true" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
