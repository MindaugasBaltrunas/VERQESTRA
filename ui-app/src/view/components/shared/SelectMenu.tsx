import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

/** Tarpas tarp trigger'io ir sąrašo, ir minimalus atstumas iki ekrano krašto. */
const GAP = 6;
const EDGE = 8;
/** Mažiau vietos už šitiek — sąrašas verčiamas į viršų. Atitinka ~4 variantus. */
const MIN_SPACE = 160;
/** Ta pati riba, kaip `max-height` `.select-menu-panel` taisyklėje. */
const MAX_HEIGHT = 280;

type PanelPlacement = { style: React.CSSProperties; above: boolean };

/**
 * Popover'io koordinatės iš TIKRO trigger'io stačiakampio. CSS jų žinoti negali, tad jos
 * vienintelės eina inline; visa likusi išvaizda lieka `dashboard.css`.
 *
 * Vertimas į viršų yra ne grožis, o matomumas: kortelė gali stovėti ekrano apačioje, ir sąrašas,
 * atsidaręs žemyn, prasidėtų už lango ribos — pirmas variantas būtų nepasiekiamas pele.
 */
function measurePanel(trigger: HTMLElement | null): PanelPlacement {
  if (!trigger) return { style: {}, above: false };
  const rect = trigger.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const spaceBelow = viewportHeight - rect.bottom - GAP - EDGE;
  const spaceAbove = rect.top - GAP - EDGE;
  const above = spaceBelow < MIN_SPACE && spaceAbove > spaceBelow;
  return {
    above,
    style: {
      left: Math.max(EDGE, Math.min(rect.left, viewportWidth - rect.width - EDGE)),
      minWidth: rect.width,
      maxHeight: Math.max(MIN_SPACE, Math.min(MAX_HEIGHT, above ? spaceAbove : spaceBelow)),
      ...(above ? { bottom: viewportHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    },
  };
}

/**
 * Valdomas dropdown su pilnu ARIA combobox+listbox šablonu (2026-08-28). Plikas `<select>`
 * neleidžia rodyti `tag` ženklelio prie varianto, tad trigger'is yra mygtukas, o pats
 * pasirinkimų sąrašas — atskiras popover'as, ne naršyklės nupieštas meniu.
 *
 * Popover'is renderinamas PORTALE prie `<body>` (2026-08-29). Būdamas `position: absolute`
 * kortelės viduje, jis priklausė nuo kiekvieno protėvio: bet kuris `overflow: hidden|auto` jį
 * apkirpdavo, o bet kuris `transform` būtų įkalinęs net `position: fixed`. Kortelė yra tik
 * dabartinė aplinka — komponentas negali reikalauti, kad kiekvienas jo naudotojas neturėtų nė
 * vieno tokio protėvio. Portale protėvių nebėra, tad apkirpti nebėra kam.
 *
 * Kaina, kurią portalas atsineša, sumokama čia pat: „paspaudimas šalia" tikrina ABI dalis
 * (šaknį ir sąrašą), o slinkimas popover'į uždaro, nes fiksuotai pozicionuotas elementas
 * trigger'io nebeseka.
 *
 * Uždarymo animacijos sąmoningai nėra: elementas montuojamas tik kai atidarytas, o atsidarymo
 * `@keyframes` suveikia automatiškai su pačiu montavimu — jokio papildomo state'o perėjimui
 * sekti nereikia.
 */
export function SelectMenu({ id, value, onChange, options, disabled, ...ariaProps }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<PanelPlacement>({ style: {}, above: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const listboxId = `${id ?? "select-menu"}-listbox`;
  const activeOptionId = open && options[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;
  const label = ariaProps["aria-label"];

  // Portale gyvenantis sąrašas nebėra šaknies viduje, tad „ne šaknyje" nebereiškia „šalia":
  // be antros patikros paspaudimas ant paties varianto būtų perskaitytas kaip išorinis.
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (rootRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);

  // Fiksuotai pozicionuotas popover'is nuslinkus puslapiui liktų kaboti ten, kur lauko jau nebėra.
  // Uždarymas čia teisingesnis nei perskaičiavimas: nuo savo lauko atsiribojęs sąrašas meluoja
  // apie tai, ką jis keičia. Slinkimas PAČIAME sąraše neuždaro — kitaip ilgas sąrašas užsivertų
  // vos pradėjus jį skaityti.
  useEffect(() => {
    if (!open) return;
    const closeOnViewportShift = (event: Event): void => {
      const target = event.target as Node | null;
      if (event.type === "scroll" && target !== null && panelRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    window.addEventListener("scroll", closeOnViewportShift, true);
    window.addEventListener("resize", closeOnViewportShift);
    return () => {
      window.removeEventListener("scroll", closeOnViewportShift, true);
      window.removeEventListener("resize", closeOnViewportShift);
    };
  }, [open]);

  // Aktyvus variantas įskrolinamas keičiant PATIES sąrašo `scrollTop`. `scrollIntoView` gali
  // paslinkti ir protėvius iki dokumento, o dokumento slinkimas šį popover'į uždaro —
  // klaviatūros navigacija būtų pati save nutraukusi.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const option = optionRefs.current[activeIndex];
    if (!panel || !option) return;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    if (optionTop < panel.scrollTop) panel.scrollTop = optionTop;
    else if (optionBottom > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = optionBottom - panel.clientHeight;
    }
  }, [open, activeIndex]);

  // Fokusas keliauja į sąrašą prieš pat piešimą: `useEffect` čia paliktų vieną kadrą, kuriame
  // klaviatūros įvykiai dar eina trigger'iui.
  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  function openAt(index: number): void {
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
    setPlacement(measurePanel(triggerRef.current));
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function commit(index: number): void {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (disabled === true) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAt(selectedIndex >= 0 ? selectedIndex : 0);
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
        close();
        break;
      case "Tab":
        // BE `preventDefault`: fokusas grąžinamas trigger'iui, ir naršyklė iš jo tęsia įprastą
        // Tab tvarką. Vien uždarius, fokusas liktų portale dokumento gale — kitas Tab nuvestų
        // į puslapio pabaigą, ne į kitą formos lauką.
        close();
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
        {...(label !== undefined ? { "aria-label": label } : {})}
      >
        <span className="select-menu-trigger-label">{selected?.label ?? ""}</span>
        <span className="select-menu-chevron" aria-hidden="true" />
      </button>
      {open && createPortal(
        <ul
          id={listboxId}
          ref={panelRef}
          className={placement.above ? "select-menu-panel select-menu-panel-above" : "select-menu-panel"}
          style={placement.style}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={activeOptionId}
          onKeyDown={handleListKeyDown}
          {...(label !== undefined ? { "aria-label": label } : {})}
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
        </ul>,
        document.body,
      )}
    </div>
  );
}
