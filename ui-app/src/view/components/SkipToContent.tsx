import { useI18n } from "../../i18n/I18nContext";

/**
 * Praleisti navigaciją (WCAG 2.4.1 „Bypass Blocks").
 *
 * Kiekviename maršrute prieš turinį stovi devyni navigacijos skirtukai ir šeši įrankių juostos
 * mygtukai. Klaviatūra dirbančiam operatoriui tai penkiolika `Tab` paspaudimų iki kiekvieno
 * ekrano — ir taip po KIEKVIENO perkrovimo.
 *
 * MYGTUKAS, o ne `<a href="#main-content">`, ir tai ne stiliaus pasirinkimas: dashboard'as
 * maršrutizuojasi per `window.location.hash` (`useRoute`), tad nuoroda į fragmentą perrašytų
 * hash'ą, `readRoute` jo neatpažintų ir operatorius vietoj turinio atsidurtų „Apžvalgoje".
 * Įprastas skip-link šablonas čia tyliai sulaužytų navigaciją.
 *
 * Taikinys randamas RUNTIME (`document.querySelector("main")`), nes vienu metu renderinamas
 * lygiai vienas `<main>`, o jų yra keturiuose puslapiuose plius klaidos riboje. `tabindex`
 * nustatomas prieš pat fokusavimą: be jo `focus()` ant ne-interaktyvaus elemento nieko nedaro.
 */
export function SkipToContent() {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className="skip-link"
      onClick={() => {
        const main = document.querySelector("main");
        if (!main) return;
        main.setAttribute("tabindex", "-1");
        main.focus();
      }}
    >
      {t("Skip to content")}
    </button>
  );
}
