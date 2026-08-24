import { useEffect, useRef, useState } from "react";
import { ROUTE_LABELS, type Route } from "../../controller/useRoute";
import { useI18n } from "../../i18n/I18nContext";

/**
 * Mobilus „Daugiau" meniu (2026-08-24, operatoriaus nurodymas).
 *
 * Siaurame ekrane devyni navigacijos skirtukai gyvena horizontaliame slinkiklyje, o įrankių juosta
 * laužiasi į kelias eilutes. Slinkiklis yra ne navigacija, o slėptuvė: nematomas skirtukas
 * neegzistuoja tam, kas jo neieško, ir nė vienas iš jų neturi bendro sąrašo, iš kurio matytųsi,
 * KAS apskritai yra.
 *
 * Meniu neša VISUS ekranus IR įrankius vienoje vietoje. Jis nepakeičia juostos — ji lieka
 * pasiekiama; jis prideda pilną sąrašą, kurio slinkiklis niekada nerodo iš karto.
 *
 * `<details>`, o ne savas dropdown'as: klaviatūra ir screen reader'iai jį moka be nė vienos
 * `aria-*` eilutės, o uždarymas paspaudus šalia yra vienintelis dalykas, kurio jam trūksta.
 */
export function MoreMenu(props: {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onRefresh: () => void;
  onResumeLoop?: (() => void) | undefined;
  onStopLoop?: (() => void) | undefined;
  canResumeLoop?: boolean | undefined;
  canStopLoop?: boolean | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const go = (route: Route): void => {
    props.onNavigate(route);
    setOpen(false);
  };

  return (
    <details className="more-menu" ref={root} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="button ghost small-button" aria-label={t("More")}>
        ☰ {t("More")}
      </summary>
      <div className="more-menu-panel">
        <p className="more-menu-heading">{t("Screens")}</p>
        <nav aria-label={t("All screens")}>
          {(Object.keys(ROUTE_LABELS) as Route[]).map((route) => (
            <button
              key={route}
              type="button"
              className={route === props.activeRoute ? "more-menu-item active" : "more-menu-item"}
              aria-current={route === props.activeRoute ? "page" : undefined}
              onClick={() => go(route)}
            >
              {t(ROUTE_LABELS[route])}
            </button>
          ))}
        </nav>

        <p className="more-menu-heading">{t("Tools")}</p>
        {/* Ciklo veiksmai čia kartojasi SĄMONINGAI: juosta siaurame ekrane gali būti nuslinkusi,
            o „Sustabdyti ciklą" yra veiksmas, kurio negalima leisti tapti nepasiekiamu. */}
        {props.onResumeLoop && (
          <button
            type="button"
            className="more-menu-item"
            disabled={props.canResumeLoop === false}
            onClick={() => {
              props.onResumeLoop?.();
              setOpen(false);
            }}
          >
            ▶ {t("Start loop")}
          </button>
        )}
        {props.onStopLoop && (
          <button
            type="button"
            className="more-menu-item"
            disabled={props.canStopLoop === false}
            onClick={() => {
              props.onStopLoop?.();
              setOpen(false);
            }}
          >
            ⏹ {t("Stop loop")}
          </button>
        )}
        <button
          type="button"
          className="more-menu-item"
          onClick={() => {
            props.onRefresh();
            setOpen(false);
          }}
        >
          ↻ {t("Refresh")}
        </button>
      </div>
    </details>
  );
}
