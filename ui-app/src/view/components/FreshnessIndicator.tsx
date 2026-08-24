import type { AgentActivityStatus } from "../../controller/useAgentActivity";
import { useI18n } from "../../i18n/I18nContext";

/**
 * TRYS SKIRTINGI FAKTAI, TRYS SKIRTINGI ŽENKLAI (2026-08-24, operatoriaus nurodymas).
 *
 * Dashboard'as turi tris nepriklausomus dalykus, kurie ilgai buvo painiojami tarpusavyje:
 *
 *   1. DUOMENŲ ŠVIEŽUMAS — kada paskutinį kartą pavyko perskaityti `/api/dashboard`. Šis modulis.
 *   2. RYŠIO AKTYVUMAS — ar `/api/events` SSE srautas gyvas. Atskiras ženklas žemiau.
 *   3. SISTEMOS SVEIKATA — ar veikia vykdymo procesai. Gyvena `RuntimePanel` ir čia neminimas.
 *
 * Devintame audito rate šviežumas ir ryšys buvo SULIETI: nutrūkęs srautas versdavo duomenis
 * „pasenusiais", nors `/api/dashboard` pollinimas veikia visiškai nepriklausomai nuo SSE ir gali
 * būti sėkmingas tą pačią sekundę. Sulietas ženklas meluoja abiem kryptimis — arba slepia gyvą
 * srautą, arba skelbia pasenusius duomenis, kurie ką tik atėjo.
 */

export type FreshnessState = "live" | "stale" | "failed" | "connecting";

export type FreshnessView = {
  state: FreshnessState;
  /** Sekundės nuo paskutinio sėkmingo skaitymo; `null`, kai dar nė karto nepavyko. */
  ageSeconds: number | null;
};

/**
 * Kiek laiko be sėkmingo atnaujinimo duomenys nustoja būti švieži.
 *
 * Dashboard'as pollina kas 30 s, tad riba yra du praleisti ratai plius atsarga: vienas
 * praleistas pollingas yra tinklo mikčiojimas, o ne pasenę duomenys.
 */
export const FRESHNESS_STALE_AFTER_MS = 75_000;

/**
 * TIK duomenų šviežumas. `AgentActivityStatus` čia SĄMONINGAI nedalyvauja — žr. modulio antraštę.
 */
export function resolveFreshness(input: {
  refreshFailed: boolean;
  loadedAt: number | null;
  now: number;
}): FreshnessView {
  const ageSeconds = input.loadedAt === null ? null : Math.max(0, Math.round((input.now - input.loadedAt) / 1000));

  // Nepavykęs atnaujinimas yra STIPRIAUSIAS signalas: jis reiškia, kad tai, ką matome, jau
  // nebeatitinka serverio.
  if (input.refreshFailed) return { state: "failed", ageSeconds };
  if (input.loadedAt === null) return { state: "connecting", ageSeconds };
  if (input.now - input.loadedAt > FRESHNESS_STALE_AFTER_MS) return { state: "stale", ageSeconds };
  return { state: "live", ageSeconds };
}

/** Duomenų ženklas: KADA paskutinį kartą pavyko perskaityti dashboard'ą. */
export function FreshnessIndicator(props: { refreshFailed: boolean; loadedAt: number | null; now: number }) {
  const { t } = useI18n();
  const { state, ageSeconds } = resolveFreshness(props);

  const label =
    state === "failed"
      ? t("Refresh failed")
      : state === "connecting"
        ? t("Loading...")
        : state === "stale"
          ? t("Data may be stale")
          : t("Data current");

  return (
    <span className={`freshness-indicator freshness-${state}`} role="status">
      <i aria-hidden="true" /> {label}
      {ageSeconds === null ? null : <small> · {t("updated")} {ageSeconds}s</small>}
    </span>
  );
}

/**
 * Ryšio ženklas: ar `/api/events` ryšys gyvas.
 *
 * Atskiras nuo šviežumo, nes atsako į KITĄ klausimą. Nutrūkęs ryšys nedaro dashboard'o duomenų
 * neteisingų — jis atima tik agentų grandinės realų laiką, ir būtent tai čia ir pasakoma.
 *
 * ŽENKLAS NEBEVADINAMAS „SRAUTU" (2026-08-24, operatoriaus radinys). Lietuviškai „srautas" šiame
 * produkte jau reiškia ciklo slot'ą — „Ciklo srautai", „Stabdyti visus srautus", „Srautas 1".
 * Todėl „Srautas gyvas" prie sustabdyto ciklo skaitėsi kaip teiginys, kad DIRBA ciklo srautas,
 * nors jų veikė nulis. Ženklas visą laiką sakė tiesą apie SSE ryšį — tik ne apie tai, ką
 * skaitytojas girdėjo. Tikslus daiktavardis čia yra visas taisymas.
 */
export function StreamIndicator({ status }: { status: AgentActivityStatus }) {
  const { t } = useI18n();
  const label =
    status === "live" ? t("Live connection") : status === "connecting" ? t("Connecting") : t("Connection lost");

  return (
    <span className={`freshness-indicator stream-${status}`} role="status" title={t("Real-time channel for the agent chain")}>
      <i aria-hidden="true" /> {label}
    </span>
  );
}
