// `GET /api/token-usage` užklausos vaizdas (etalonas: AG_loop orchestrator/runtime/token-usage.ts
// `filterTokenUsageRecords` + `buildTokenUsageQueryResponse`).
//
// Kodėl ATSKIRAS modulis nuo `token-usage-summary`: tai du skirtingi klausimai su dviem
// skirtingais atsakymais. `summarizeTokenUsage` grąžina SUVESTINES eilutes (`ag report` kelias),
// o šis modulis — ĮRAŠUS su puslapiavimu. Iki 2026-08-23 UI audito `/api/token-usage` buvo
// prijungtas prie suvestinės, tad klientas gaudavo `TokenUsageSummaryRecord[]` ten, kur laukia
// `{ records, pagination }` — visa `#/analytics` lentelė likdavo tuščia, o filtrai (`model`,
// `phase`, `from`, `to`, `limit`, `offset`) buvo IGNORUOJAMI.
//
// Kontrakto pastaba (etalono task 936, perkelta 1:1): endpoint'as sąmoningai grąžina TIK
// `records`. Serverio suvestinės čia nėra, nes ji negalėtų gerbti kliento-only `task_id`
// substring filtro — agregavimas gyvena VIENOJE vietoje, `ui-app/src/model/tokenUsageViewModel`.
//
// Skaitymas TOLERANTIŠKAS: sugadinta telemetrijos eilutė kainuoja tik save pačią, o ne visą
// puslapį (dashboard'as yra diagnostikos paviršius).

import { parseJsonlObjects } from "../learning/usage-view.js";

/**
 * Vienas žurnalo įrašas taip, kaip jį mato klientas.
 *
 * Eilutė perduodama VISA (`Record<string, unknown>` likutis): `attempt_id`, `outcome`,
 * `total_cost_usd` ir kiti laukai priklauso kliento kontraktui, o siauras pjūvis juos tyliai
 * numestų — tai būtų antra to paties audito klaidos rūšis, tik mažesnė.
 */
export type TokenUsageQueryRecord = Record<string, unknown> & {
  ts: string;
  task_id: string;
  phase: string;
  model: string;
};

export type TokenUsageFilter = {
  model?: string | undefined;
  phase?: string | undefined;
  task_id?: string | undefined;
  /** Įskaitanti ISO 8601 apatinė riba, lyginama su įrašo `ts`. */
  from?: string | undefined;
  /** Įskaitanti ISO 8601 viršutinė riba, lyginama su įrašo `ts`. */
  to?: string | undefined;
};

export type TokenUsagePagination = {
  total_records: number;
  returned_records: number;
  offset: number;
  limit: number | null;
  has_more: boolean;
};

export type TokenUsageQueryResponse = {
  records: TokenUsageQueryRecord[];
  pagination?: TokenUsagePagination;
};

/** Numatytoji ir didžiausia `?limit` reikšmė; `0` reiškia „be ribos". */
export const DEFAULT_TOKEN_USAGE_LIMIT = 500;
export const MAX_TOKEN_USAGE_LIMIT = 5000;

/**
 * Tolerantiškas įrašų skaitymas: eilutė be `phase`/`task_id`/`model` praleidžiama, nes be jų
 * įrašo nei filtruoti, nei parodyti neįmanoma.
 */
export function parseTokenUsageQueryRecords(raw: string | undefined): TokenUsageQueryRecord[] {
  return parseJsonlObjects(raw).flatMap((row) => {
    const phase = row["phase"];
    const taskId = row["task_id"];
    const model = row["model"];
    if (typeof phase !== "string" || typeof model !== "string" || typeof taskId !== "string") return [];
    return [{ ...row, ts: typeof row["ts"] === "string" ? row["ts"] : "", task_id: taskId, phase, model }];
  });
}

/**
 * Data BE laiko dalies išplečiama iki visos paros. Be to `to=2026-08-23` atmestų VISUS tos dienos
 * įrašus (`"2026-08-23T09:00:00Z" > "2026-08-23"`), t. y. filtras tyliai prarastų paskutinę dieną.
 *
 * PARA ČIA YRA UTC PARA, ir tai svarbu žinoti kiekvienam kvietėjui: dashboard'as šia šaka
 * NESINAUDOJA — `useTokenUsageController` datą paverčia VIETINĖS paros ISO riba dar prieš
 * užklausą, tad serveris gauna tikslų momentą ir jo neinterpretuoja (tą sulygiavimą laiko
 * `useTokenUsageController.test.ts` „sends date inputs as inclusive local-day ISO boundaries").
 * Bet kuris kitas klientas, atsiuntęs plikas `YYYY-MM-DD`, gaus UTC parą — tai KITAS langas nei
 * matomas dashboard'e, ir jei tokia semantika netinka, riba privalo būti apskaičiuota kvietėjo
 * pusėje, kur laiko juosta žinoma. Serveris jos nežino ir spėti negali.
 */
function inclusiveDateBoundary(value: string | undefined, boundary: "start" | "end"): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`;
}

export function filterTokenUsageRecords(
  records: readonly TokenUsageQueryRecord[],
  filter: TokenUsageFilter = {},
): TokenUsageQueryRecord[] {
  const from = inclusiveDateBoundary(filter.from, "start");
  const to = inclusiveDateBoundary(filter.to, "end");
  return records.filter((record) => {
    if (filter.model && record.model !== filter.model) return false;
    if (filter.phase && record.phase !== filter.phase) return false;
    if (filter.task_id && record.task_id !== filter.task_id) return false;
    if (from && record.ts < from) return false;
    if (to && record.ts > to) return false;
    return true;
  });
}

/**
 * Užklausos atsakymas su puslapiavimu nuo ŽURNALO GALO: naujausi įrašai yra paskutiniai, tad
 * `offset: 0` reiškia „naujausi", o ne „seniausi". `has_more` sako, ar už jų dar yra istorijos.
 */
export function buildTokenUsageQueryResponse(
  raw: string | undefined,
  filter: TokenUsageFilter = {},
  pagination?: { limit?: number | undefined; offset?: number | undefined },
): TokenUsageQueryResponse {
  const filtered = filterTokenUsageRecords(parseTokenUsageQueryRecords(raw), filter);
  if (!pagination) return { records: filtered };

  const offset = Math.max(0, Math.floor(pagination.offset ?? 0));
  const limit = pagination.limit === undefined ? undefined : Math.max(1, Math.floor(pagination.limit));
  const end = Math.max(0, filtered.length - offset);
  const start = limit === undefined ? 0 : Math.max(0, end - limit);
  const records = filtered.slice(start, end);
  return {
    records,
    pagination: {
      total_records: filtered.length,
      returned_records: records.length,
      offset,
      limit: limit ?? null,
      has_more: start > 0,
    },
  };
}

/**
 * `?limit=` reikšmė: `0` yra AIŠKUS „be ribos", šiukšlė krenta į numatytąją, o viršutinės lubos
 * saugo nuo vienos užklausos, atiduodančios visą žurnalą.
 */
export function normalizeTokenUsageLimit(raw: string | null): number | undefined {
  if (raw === "0") return undefined;
  const parsed = Number.parseInt(raw ?? "", 10);
  const value = Number.isFinite(parsed) ? parsed : DEFAULT_TOKEN_USAGE_LIMIT;
  return Math.max(1, Math.min(value, MAX_TOKEN_USAGE_LIMIT));
}

export function normalizeTokenUsageOffset(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Math.max(0, Number.isFinite(parsed) ? parsed : 0);
}
