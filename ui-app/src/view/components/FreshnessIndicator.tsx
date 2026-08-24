import type { AgentActivityStatus } from "../../controller/useAgentActivity";
import { useI18n } from "../../i18n/I18nContext";

/**
 * Duomenų šviežumo ženklelis (2026-08-24 UI auditas, devintas ratas — operatoriaus radinys).
 *
 * Iki šio komponento `DashboardPage` rodė BESĄLYGIŠKĄ literalą „Gyvi duomenys". Tai buvo
 * tvirtinimas, kurio niekas netikrino: jis liko toks pat, kai srautas nutrūkdavo, kai paskutinis
 * atnaujinimas nepavykdavo ir kai duomenys buvo dešimties minučių senumo. Tame pačiame ekrane
 * apžvalgos metrika tuo metu galėjo sakyti „Pasenusi užduoties būsena" — ir operatorius matydavo
 * puslapį, prieštaraujantį pačiam sau.
 *
 * Du dalykai, kurie tą prieštaravimą uždaro:
 *
 *   1. ŽENKLELIS UŽSITARNAUJA SAVO ŽODĮ. „Gyvi" sakoma tik tada, kai srautas prisijungęs IR
 *      paskutinis atnaujinimas pavyko. Kitu atveju sakoma, kas iš tikrųjų yra.
 *   2. ŽENKLELIS ĮVARDIJA SAVO DALYKĄ. Rodomas duomenų AMŽIUS, tad matyti, kad kalbama apie
 *      dashboard'o kanalą, o ne apie užduoties būseną. „Gyvi duomenys" ir „pasenusi užduoties
 *      būsena" yra du skirtingi faktai, ir abu gali būti teisingi vienu metu — bet tik tada, kai
 *      ekranas pasako, apie ką kiekvienas jų kalba.
 *
 * `ReliabilityPage` tą patį `freshness-indicator` jau rodė su tikra žyma (`Updated <data>`) —
 * dashboard'as buvo vienintelė išimtis.
 */

export type FreshnessState = "live" | "stale" | "failed" | "connecting";

export type FreshnessView = {
  state: FreshnessState;
  /** Sekundės nuo paskutinio sėkmingo skaitymo; `null`, kai dar nė karto nepavyko. */
  ageSeconds: number | null;
};

/**
 * Kiek laiko be sėkmingo atnaujinimo duomenys nustoja būti „gyvi".
 *
 * Dashboard'as pollina kas 30 s, tad riba yra du praleisti ratai plius atsarga: vienas
 * praleistas pollingas yra tinklo mikčiojimas, o ne pasenę duomenys.
 */
export const FRESHNESS_STALE_AFTER_MS = 75_000;

export function resolveFreshness(input: {
  status: AgentActivityStatus;
  refreshFailed: boolean;
  loadedAt: number | null;
  now: number;
}): FreshnessView {
  const ageSeconds = input.loadedAt === null ? null : Math.max(0, Math.round((input.now - input.loadedAt) / 1000));

  // Nepavykęs atnaujinimas yra STIPRIAUSIAS signalas: jis reiškia, kad tai, ką matome, jau
  // nebeatitinka serverio, ir jokia srauto būsena to nepaneigia.
  if (input.refreshFailed) return { state: "failed", ageSeconds };
  if (input.loadedAt === null) return { state: "connecting", ageSeconds };
  if (input.now - input.loadedAt > FRESHNESS_STALE_AFTER_MS) return { state: "stale", ageSeconds };
  // Nutrūkęs srautas nepadaro `/api/dashboard` duomenų neteisingų, bet atima realaus laiko dalį,
  // tad žodis „gyvi" jam nebepriklauso.
  if (input.status === "disconnected") return { state: "stale", ageSeconds };
  return { state: "live", ageSeconds };
}

export function FreshnessIndicator(props: {
  status: AgentActivityStatus;
  refreshFailed: boolean;
  loadedAt: number | null;
  now: number;
}) {
  const { t } = useI18n();
  const { state, ageSeconds } = resolveFreshness(props);

  const label =
    state === "failed"
      ? t("Refresh failed")
      : state === "connecting"
        ? t("Loading...")
        : state === "stale"
          ? t("Data may be stale")
          : t("Live data");

  return (
    <span className={`freshness-indicator freshness-${state}`} role="status">
      <i aria-hidden="true" /> {label}
      {ageSeconds === null ? null : <small> · {t("updated")} {ageSeconds}s</small>}
    </span>
  );
}
