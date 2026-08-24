// `/api/logs` skaitymo TAISYKLĖS — grynos, be IO.
//
// NAUJA FUNKCIJA, ne perkėlimas (operatoriaus sprendimas, 2026-08-24). Etalono orkestratoriaus
// UI serveris (`AG/orchestrator/src/interfaces/http/ui-server.ts`) aptarnavo septynis `/api/**`
// maršrutus, ir `/api/logs` tarp jų NEBUVO. Tas kelias visame AG_loop egzistavo tik dviejose
// vietose, abiejose `AG/mobile-gateway` viduje: adapteryje, kuris jo prašo, ir jo teste, kuris
// HTTP sluoksnį pakeičia fake'u. Tad mobile pusė metus kalbėjo su maršrutu, kurio nė vienas
// serveris neaptarnavo — „veidrodis", kurį VERQESTRA E8 auditas įvardijo kaip defektų klasę.
//
// Kadangi etalonas sprendimų čia nepriėmė, jie priimami dabar ir užrašomi:
//
//   1. VARDŲ ALLOWLIST, ne laisvas kelias. Klientas siunčia `log=claude|orchestrator|checks`,
//      o failo vardą parenka serveris. Laisvas vardas būtų kelio traversal primityvas į
//      `vq/logs`, o šis maršrutas turi token'ą, bet ne failų sistemos ribą.
//   2. TIK trys vardai — tiksliai tie, kuriuos deklaruoja mobile kontraktas
//      (`AG_LOOP_LOG_NAMES`). Platesnis sąrašas būtų funkcija, kurios niekas neprašė; `hooks`,
//      `secret-scan` ir kiti guard'ų žurnalai neša daugiau host'o detalės nei operatoriui
//      reikia telefone.
//   3. NESANTIS failas yra TUŠČIAS atsakymas, ne 404. Žurnalas, į kurį dar niekas nerašė, yra
//      normali būsena (šviežias `vq/`), o 404 čia reikštų „nėra tokio žurnalo" — kitą faktą.
//   4. Ribos taikomos nuo GALO ir dvigubai — eilučių ir simbolių. Etalono `ui/log-service.ts`
//      `boundedTail` yra elgesio atskaitos taškas (16 eil., `wont-migrate`), ir jo semantika
//      perkelta 1:1: paskutinės eilutės, o per ilga eilutė nukerpama iš PRIEKIO, nes žurnalo
//      eilutės pabaiga yra šviežiausia jos dalis.

/** Žurnalai, kuriuos šis maršrutas atiduoda. Kliento vardas → failo vardas `vq/logs`. */
export const UI_LOG_FILES: Readonly<Record<string, string>> = Object.freeze({
  claude: "claude-last.log",
  orchestrator: "orchestrator.log",
  checks: "checks-last.log",
});

export type UiLogName = keyof typeof UI_LOG_FILES;

export const UI_LOG_NAMES: readonly string[] = Object.freeze(Object.keys(UI_LOG_FILES));

/** Tos pačios ribos, kurias deklaruoja mobile `ag-loop-ui-read-port`, kad nė viena pusė neklamptų. */
export const UI_LOG_LINE_LIMIT = 200;
export const UI_LOG_LINE_DEFAULT = 100;
export const UI_LOG_LINE_CHAR_LIMIT = 4096;

export type UiLogsResponse = Readonly<{
  log: string;
  lines: readonly string[];
  /** True, kai ribos nukirpo bent vieną eilutę arba bent vienos eilutės uodegą. */
  truncated: boolean;
}>;

/** Ar klientas nurodė žinomą žurnalą. Nežinomas vardas yra 400, ne tylus numatytasis. */
export function isUiLogName(value: string | null): value is UiLogName {
  return value !== null && Object.prototype.hasOwnProperty.call(UI_LOG_FILES, value);
}

export function uiLogFileName(log: UiLogName): string {
  // Bracket prieiga: `UI_LOG_FILES` yra `Record<string, string>`, tad taško prieiga pažeistų
  // `noPropertyAccessFromIndexSignature`. Reikšmė garantuota `isUiLogName` vartų.
  return UI_LOG_FILES[log] as string;
}

/** `?lines=` normalizavimas: ne skaičius arba už ribų — numatytasis, niekada klaida. */
export function normalizeUiLogLines(raw: string | null): number {
  if (raw === null || raw.trim().length === 0) return UI_LOG_LINE_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return UI_LOG_LINE_DEFAULT;
  return Math.min(parsed, UI_LOG_LINE_LIMIT);
}

/**
 * Paskutinės `maxLines` eilutės, kiekviena ne ilgesnė kaip `maxChars`.
 *
 * Etalono `boundedTail` semantika, bet grąžinamas SĄRAŠAS, o ne sujungtas tekstas: kvietėjas
 * (HTTP maršrutas) atiduoda JSON masyvą, ir sujungimas tik tam, kad jį vėl skaidytų, prarastų
 * informaciją apie tuščias eilutes.
 */
export function boundedLogLines(
  content: string,
  maxLines: number,
  maxChars: number,
): Readonly<{ lines: readonly string[]; truncated: boolean }> {
  const all = content.split(/\r?\n/);
  // Uodeginis tuščias elementas yra failo baigiamasis `\n`, ne eilutė.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const kept = all.slice(-maxLines);
  let truncated = kept.length < all.length;
  const lines = kept.map((line) => {
    if (line.length <= maxChars) return line;
    truncated = true;
    // Iš PRIEKIO: žurnalo eilutės pabaiga yra šviežiausia ir informatyviausia jos dalis.
    return line.slice(-maxChars);
  });
  return Object.freeze({ lines: Object.freeze(lines), truncated });
}

/** Pilnas atsakymo vokas iš žurnalo turinio. `undefined` turinys = žurnalo dar nėra. */
export function buildUiLogsResponse(
  log: UiLogName,
  content: string | undefined,
  maxLines: number,
): UiLogsResponse {
  if (content === undefined) {
    return Object.freeze({ log, lines: Object.freeze([]), truncated: false });
  }
  const bounded = boundedLogLines(content, maxLines, UI_LOG_LINE_CHAR_LIMIT);
  return Object.freeze({ log, lines: bounded.lines, truncated: bounded.truncated });
}
