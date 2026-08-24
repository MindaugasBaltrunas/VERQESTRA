// Dashboard'o HTTP maršrutizatorius (etalonas: AG_loop interfaces/http/ui-server.ts maršrutų
// blokas).
//
// VERQESTRA nukrypimas nuo etalono, sąmoningas: maršrutas GRĄŽINA atsakymo aprašą, o ne rašo į
// `ServerResponse`. Etalone kiekvienas kelias pats kvietė `response.writeHead(...)`, tad nė vienos
// ribos (kas yra 403, kada token'as tikrinamas, ką grąžina nežinomas maršrutas) nebuvo įmanoma
// patikrinti be tikro HTTP serverio. Čia transportas lieka kompozicijai (VQ-504), o visa
// SPRENDIMŲ dalis testuojama tiesiogiai.
//
// VARTŲ TVARKA yra kontraktas ir jos keisti negalima:
//   1. loopback `Host`            — DNS rebinding apsauga, prieš viską;
//   2. projekto TAPATYBĖ          — vienintelis maršrutas be token'o (žr. `ui-security`);
//   3. `/api/**` token'as         — skaitymai;
//   4. POST mutacijos token'as    — rašymai (statiniai failai jo nereikalauja).
//
// Mutacijos gyvena `ui-router-mutations`: skaitymo ir rašymo pusės elgiasi PRIEŠINGAI klaidos
// atveju (skaitymas degraduoja, rašymas krenta garsiai), o dydžio vartas neleidžia jų laikyti
// viename faile.

import {
  FORBIDDEN_HOST_RESPONSE,
  FORBIDDEN_TOKEN_RESPONSE,
  INTERNAL_ERROR_RESPONSE,
} from "./ui-error-mapping.js";
import { UI_IDENTITY_ROUTE, projectFingerprint, uiIdentityPayload } from "./ui-port-rules.js";
import { UnknownTaskBucketError } from "./workflow-buckets.js";
import { hasValidApiToken, isLoopbackHost } from "./ui-security.js";
import { json, toResponse, type UiRouteRequest, type UiRouteResponse, type UiRouterDeps } from "./ui-router-model.js";
import { handlePost } from "./ui-router-mutations.js";
import {
  normalizeTokenUsageLimit,
  normalizeTokenUsageOffset,
} from "../../application/analytics/token-usage-query.js";

export type {
  PolicyDecisionRequest,
  PolicyProposalInput,
  UiRouteRequest,
  UiRouteResponse,
  UiRouterDeps,
  UiRouterPorts,
} from "./ui-router-model.js";

/** Nežinomas `/api/**` kelias yra 404 JSON, o ne HTML — klientas laukia JSON kiekviename API. */
const API_NOT_FOUND: UiRouteResponse = { kind: "json", status: 404, data: { error: "not found" } };

export async function handleUiRequest(deps: UiRouterDeps, request: UiRouteRequest): Promise<UiRouteResponse> {
  const ports = deps.ports;

  // 1) DNS rebinding vartai — prieš viską, įskaitant tapatybės maršrutą.
  if (!isLoopbackHost(request.headers["host"] as string | undefined)) {
    return toResponse(FORBIDDEN_HOST_RESPONSE);
  }

  let url: URL;
  try {
    url = new URL(request.url, "http://127.0.0.1");
  } catch {
    // Koduotas šiukšlinas segmentas (`decodeURIComponent("%")`) etalone virsdavo neperimta
    // išimtimi, atsakymo neišsiųsdavo, o socket'as kabodavo iki timeout'o.
    return { kind: "json", status: 400, data: { error: "Malformed request URL" } };
  }
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  // 2) Projekto TAPATYBĖ — vienintelis maršrutas be token'o. Ne-GET metodas čia nesustoja ir
  //    krenta į token'ų vartus žemiau.
  if (method === "GET" && pathname === UI_IDENTITY_ROUTE) {
    // Forma statoma VIENOJE vietoje (`uiIdentityPayload`) — zondas ir maršrutas negali išsiskirti.
    return json(uiIdentityPayload(projectFingerprint(deps.projectRoot, deps.platform ?? process.platform)));
  }

  const isApi = pathname.startsWith("/api/");
  // 3) Skaitymo vartai.
  if (isApi && !hasValidApiToken(request.headers, deps.uiToken)) {
    return toResponse(FORBIDDEN_TOKEN_RESPONSE);
  }

  if (method === "GET") {
    const read = await handleGet(deps, pathname, url);
    if (read) return read;
  }

  // 4) Mutacijų vartai: POST be token'o neįvyksta niekada, net ne-`/api` keliuose.
  if (method === "POST" && !hasValidApiToken(request.headers, deps.uiToken)) {
    return toResponse(FORBIDDEN_TOKEN_RESPONSE);
  }
  if (method === "POST") {
    const mutation = await handlePost(deps, pathname, request);
    if (mutation) return mutation;
  }

  if (isApi) return API_NOT_FOUND;
  // Statinis turinys: SPA kelią atiduoda adapteris (jis moka `index.html` fallback'ą).
  return ports.hasStaticAssets() ? { kind: "static", urlPath: pathname } : { kind: "empty", status: 404 };
}

async function handleGet(deps: UiRouterDeps, pathname: string, url: URL): Promise<UiRouteResponse | undefined> {
  const ports = deps.ports;
  const guarded = async (read: () => Promise<unknown>): Promise<UiRouteResponse> => {
    try {
      return json(await read());
    } catch (error) {
      ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
      return toResponse(INTERNAL_ERROR_RESPONSE);
    }
  };

  switch (pathname) {
    case "/api/events":
      return { kind: "sse" };
    case "/api/dashboard":
      return await guarded(() => ports.dashboardData(deps.uiToken));
    case "/api/policies/proposals":
      return await guarded(() => ports.listPolicyProposals());
    case "/api/token-usage":
      return await guarded(() => ports.tokenUsage(url.searchParams));
    case "/api/logs": {
      // Nežinomas žurnalo vardas yra 400, o ne numatytasis žurnalas: klientas paprašė kažko
      // konkretaus, ir atiduoti jam KITĄ žurnalą tuo pačiu voku reikštų atsakymą, kurio jis
      // negali atskirti nuo teisingo. Portas tam grąžina `undefined`.
      //
      // `guarded` čia netaikomas, nes jis kiekvieną baigtį verčia į 200 arba 500, o šis
      // maršrutas turi TRIS: 200, 400 ir 500. Klaidos kelias toks pat kaip `/api/tasks`.
      try {
        const view = await ports.logs(url.searchParams);
        if (view === undefined) {
          return { kind: "json", status: 400, data: { error: "invalid log name" } };
        }
        return json(view);
      } catch (error) {
        ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
        return toResponse(INTERNAL_ERROR_RESPONSE);
      }
    }
    case "/api/token-analytics":
      return await guarded(() => ports.tokenAnalytics());
    case "/api/reliability-analytics":
      // `?fresh=1` yra operatoriaus „Atnaujinti": be jo atsakymas gali ateiti iš 10 s kešo, o su
      // juo git zondai paleidžiami iš naujo. Iki 2026-08-23 audito parametras buvo IGNORUOJAMAS.
      return await guarded(() => ports.reliabilityAnalytics(url.searchParams.get("fresh") === "1"));
    case "/api/benchmark/report":
      return await guarded(() => ports.benchmarkReport());
    case "/api/tasks": {
      // Etalono (ir ui-app `fetchWorkflowTasks`) kontraktas: `?bucket=<b>` grąžina VIENO bucket'o
      // pilną sąrašą, nežinomas bucket'as — 400. Iki 2026-08-23 parametras buvo IGNORUOJAMAS ir
      // klientas vietoje `{name,tasks,totalCount}` gaudavo visų bucket'ų masyvą — tylus UI lūžis.
      const bucket = url.searchParams.get("bucket");
      if (bucket === null) return await guarded(() => ports.workflowBuckets());
      try {
        return json(await ports.workflowBucketTasks(bucket));
      } catch (error) {
        if (error instanceof UnknownTaskBucketError) {
          return { kind: "json", status: 400, data: { error: "invalid task bucket" } };
        }
        ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
        return toResponse(INTERNAL_ERROR_RESPONSE);
      }
    }
    case "/api/waves":
      return await guarded(() => ports.wavesView(deps.eventLimitFromQuery(url.searchParams)));
    default:
      return undefined;
  }
}

/**
 * `/api/token-usage` filtras iš query.
 *
 * `task_id` čia SĄMONINGAI nėra: serveris jį lygintų tiksliai, o UI reikia substring paieškos,
 * tad `task_id` visada taikomas kliente (`tokenUsageViewModel`). Serverio filtras jį tyliai
 * susiaurintų iki tikslaus atitikmens.
 */
export function tokenUsageQueryFrom(query: URLSearchParams): {
  filter: { model?: string; phase?: string; from?: string; to?: string };
  pagination: { limit?: number; offset: number };
} {
  const text = (key: string): string | undefined => query.get(key) ?? undefined;
  const limit = normalizeTokenUsageLimit(query.get("limit"));
  const model = text("model");
  const phase = text("phase");
  const from = text("from");
  const to = text("to");
  return {
    filter: {
      ...(model === undefined ? {} : { model }),
      ...(phase === undefined ? {} : { phase }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    },
    pagination: {
      ...(limit === undefined ? {} : { limit }),
      offset: normalizeTokenUsageOffset(query.get("offset")),
    },
  };
}
