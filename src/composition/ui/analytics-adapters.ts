// Dashboard'o ANALITIKOS portų surišimas (manual DI, LAY-2): token usage, token analytics,
// patikimumas ir benchmark ataskaita.
//
// Iškelta iš `router-adapters` ne dėl dydžio vartų, o dėl to, kad visi keturi maršrutai turi tą
// pačią savybę, kurios kiti neturi: jie skaito TELEMETRIJĄ — append-only žurnalus, kuriuos rašo
// kitas procesas ir kuriuose sugadinta eilutė yra normalu. Todėl visi keturi skaito
// TOLERANTIŠKAI: viena bloga eilutė kainuoja tik save, o ne visą puslapį.

import path from "node:path";
import {
  buildTokenUsageQueryResponse,
  type TokenUsageQueryResponse,
} from "../../application/analytics/token-usage-query.js";
import {
  buildUiLogsResponse,
  isUiLogName,
  normalizeUiLogLines,
  uiLogFileName,
  type UiLogsResponse,
} from "../../application/analytics/ui-log-query.js";
import {
  buildTokenAnalyticsResponse,
  type TokenAnalyticsResponse,
} from "../../application/learning/token-analytics-snapshot.js";
import {
  loadReliabilityAnalytics,
  type ReliabilityAnalyticsResponse,
} from "../../application/learning/reliability-report.js";
import { readBenchmarkReportView } from "../../application/benchmark/suite-report-view.js";
import { tokenUsageQueryFrom } from "../../interfaces/http/ui-router.js";
import { currentCommitResolver, gitLogNumstat, gitStatusPorcelain } from "../../infrastructure/git/git-client.js";
import { run } from "../../infrastructure/process/run-process.js";
import { readSessionFileKinds, readSessionWrites } from "../../infrastructure/state/session-activity.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { learningFs } from "../runtime/node-adapters.js";

export type AnalyticsAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
};

/**
 * `GET /api/token-usage` — ĮRAŠAI su filtrais ir puslapiavimu.
 *
 * Iki 2026-08-23 audito antro rato čia buvo prijungta `summarizeTokenUsage` SUVESTINĖ, tad
 * klientas gaudavo suvestinės eilutes ten, kur laukia `{ records, pagination }`, o visi query
 * parametrai buvo ignoruojami — `#/analytics` lentelė likdavo tuščia be jokios klaidos.
 */
export async function tokenUsageQuery(
  input: AnalyticsAdapterInput,
  query: URLSearchParams,
): Promise<TokenUsageQueryResponse> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(input.runtimeRoot, "logs", "token-usage.jsonl"));
  const { filter, pagination } = tokenUsageQueryFrom(query);
  return buildTokenUsageQueryResponse(raw, filter, pagination);
}

/**
 * `GET /api/logs` — vieno žurnalo uodega.
 *
 * NAUJAS maršrutas (2026-08-24, operatoriaus sprendimas). Priežastis ir priimti sprendimai —
 * `application/analytics/ui-log-query.ts`; čia lieka tik IO: failo vardą parenka SERVERIS iš
 * allowlist'o, tad kliento reikšmė niekada nepatenka į kelią.
 *
 * `undefined` grąžinama TIK nežinomam žurnalo vardui — maršrutas iš to daro 400. Nesantis
 * failas duoda tuščią voką, nes žurnalas, į kurį dar niekas nerašė, yra normali būsena.
 */
export async function uiLogs(
  input: AnalyticsAdapterInput,
  query: URLSearchParams,
): Promise<UiLogsResponse | undefined> {
  const log = query.get("log");
  if (!isUiLogName(log)) return undefined;
  const raw = await nodeFsAdapter.readTextFileIfExists(
    path.join(input.runtimeRoot, "logs", uiLogFileName(log)),
  );
  return buildUiLogsResponse(log, raw, normalizeUiLogLines(query.get("lines")));
}

/**
 * `GET /api/token-analytics` — šeimų grupės, optimizavimo kandidatai ir snapshot'ų istorija.
 *
 * Anksčiau čia buvo grąžinamas ŽALIAS `token-analytics.json` snapshot'as (arba `null`), t. y.
 * vienas iš trijų atsakymo laukų vietoje viso atsakymo.
 */
export function tokenAnalytics(input: AnalyticsAdapterInput): Promise<TokenAnalyticsResponse> {
  return buildTokenAnalyticsResponse(learningFs, input.runtimeRoot);
}

/**
 * `GET /api/reliability-analytics` — su 10 s kešu.
 *
 * Kešas nėra optimizacija „šiaip": šis kelias paleidžia git subprocesus, o dashboard'as jį
 * pollina. `fresh` yra operatoriaus „Atnaujinti" mygtukas, ir iki šio surišimo jis buvo
 * ignoruojamas — kaip ir pats kešas, tad kiekvienas pollingas sukdavo git iš naujo.
 */
export function reliabilityAnalytics(
  input: AnalyticsAdapterInput,
  fresh: boolean,
): Promise<ReliabilityAnalyticsResponse> {
  return loadReliabilityAnalytics(
    {
      fs: learningFs,
      gitLog: (sinceDays) => gitLogNumstat(input.projectRoot, sinceDays),
      gitStatusPorcelain: () => gitStatusPorcelain(input.projectRoot),
      sessionWrites: () => readSessionWrites(input.runtimeRoot),
      sessionFileKinds: () => readSessionFileKinds(input.runtimeRoot),
    },
    { runtimeRoot: input.runtimeRoot },
    fresh,
  );
}

/** `GET /api/benchmark/report` — backend ataskaita atiduodama be jokio perskaičiavimo (BENCH-11). */
export function benchmarkReport(input: AnalyticsAdapterInput): Promise<unknown> {
  return readBenchmarkReportView(
    {
      statPath: (absolutePath) => nodeFsAdapter.statPath(absolutePath),
      readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
      listDirectory: (absoluteDir) => nodeFsAdapter.listDirectory(absoluteDir),
    },
    {
      projectRoot: input.projectRoot,
      currentAgCommit: currentCommitResolver,
      // Staleness tik matavimui reikšmingais keliais (2026-08-26): klaida ar timeout'as
      // grąžina `undefined`, ir view fail-closed lieka prie senos „SHA nesutampa = stale".
      changedPathsSince: async (projectRoot, sinceCommit) => {
        const result = await run("git", ["-C", projectRoot, "diff", "--name-only", `${sinceCommit}..HEAD`], {
          cwd: projectRoot,
        });
        if (result.code !== 0) return undefined;
        return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
      },
    },
  );
}
