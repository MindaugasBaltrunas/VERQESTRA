import { Fragment, useEffect, useRef, useState } from "react";
import { ROUTE_LABELS, type Route } from "../../../controller/useRoute";
import { useThemeController } from "../../../controller/useThemeController";
import { useI18n } from "../../../i18n/I18nContext";

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
 *
 * Sekcijos (2026-09-02, UI auditas P3): 390×844 ekrane 10 ekranų vienoje sekcijoje ir atskiri
 * pilno pločio tema/kalba mygtukai stumdavo turinį 757px į 589px matomo — antra slinkimo zona
 * per pačią mažiausią naudojamą sąsają. Grupavimas tik perstato tuos pačius `ROUTE_LABELS`
 * įrašus po antraštėmis; nė vienas ekranas nedingsta ir tvarka sąraše nesikeičia.
 */
const SCREEN_SECTIONS: readonly { heading: string; routes: readonly Route[] }[] = [
  { heading: "Core screens", routes: ["overview", "tasks", "reviews"] },
  { heading: "Insights", routes: ["learning", "analytics", "optimization", "reliability"] },
  { heading: "Platform", routes: ["benchmark", "compression", "system"] },
];
export function MoreMenu(props: {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onRefresh: () => void;
  onResumeLoop?: (() => void) | undefined;
  onStopLoop?: (() => void) | undefined;
  canResumeLoop?: boolean | undefined;
  canStopLoop?: boolean | undefined;
}) {
  const { t, language, setLanguage } = useI18n();
  const { theme, toggleTheme } = useThemeController();
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
        <nav aria-label={t("All screens")}>
          {SCREEN_SECTIONS.map((section) => (
            <Fragment key={section.heading}>
              <p className="more-menu-heading">{t(section.heading)}</p>
              {section.routes.map((route) => (
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
            </Fragment>
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
        {/* Tema ir kalba čia atsirado 2026-08-24 kartu su kompaktiška mobilia juosta: juostai
            susitraukus iki vienos eilutės, jos abi būtų dingusios BE pakaitalo — tiksliai ta klaida,
            kurią dešimtas ratas uždarė ciklo mygtukams. Meniu dengia viską, ką juosta rodė.
            Viena eilutė (2026-09-02): atskiri pilno pločio mygtukai temai ir kalbai buvo didžiausias
            slinkimo zonos „valgytojas" po ekranų sąrašo — sutraukta į vieną kompaktišką eilutę. */}
        <div className="more-menu-settings-row">
          <button type="button" className="more-menu-item more-menu-settings-theme" onClick={() => toggleTheme()}>
            {theme === "dark" ? `☀ ${t("Light")}` : `🌙 ${t("Dark")}`}
          </button>
          <div className="more-menu-languages" role="group" aria-label={t("Language")}>
            <button
              type="button"
              className={language === "lt" ? "more-menu-item active" : "more-menu-item"}
              aria-pressed={language === "lt"}
              onClick={() => setLanguage("lt")}
            >
              LT
            </button>
            <button
              type="button"
              className={language === "en" ? "more-menu-item active" : "more-menu-item"}
              aria-pressed={language === "en"}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}
