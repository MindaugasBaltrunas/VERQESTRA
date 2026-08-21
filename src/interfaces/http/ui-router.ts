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

import {
  FORBIDDEN_HOST_RESPONSE,
  FORBIDDEN_TOKEN_RESPONSE,
  INTERNAL_ERROR_RESPONSE,
  mapJsonBodyError,
  mapTaskTriageError,
  mapUploadError,
  type HttpErrorResponse,
} from "./ui-error-mapping.js";
import { UI_IDENTITY_ROUTE, UI_IDENTITY_SERVICE, projectFingerprint } from "./ui-port-rules.js";
import { hasValidApiToken, isLoopbackHost, type RequestHeaders } from "./ui-security.js";
import type { TaskTriageAction } from "./ui-task-actions.js";

export type UiRouteRequest = {
  method: string;
  /** Žalias URL su query — maršrutui reikia ir kelio, ir parametrų. */
  url: string;
  headers: RequestHeaders;
  /** JSON kūnas; per didelis kūnas META, ir tai virsta 413, ne 500. */
  readJsonBody(): Promise<unknown>;
  /** Žalias kūnas įkėlimui (jį parsina `task-upload`). */
  readRawBody(): Promise<string>;
};

export type UiRouteResponse =
  | { kind: "json"; status: number; data: unknown }
  | { kind: "text"; status: number; text: string }
  | { kind: "empty"; status: number }
  /** Statinis failas iš dist katalogo; kelio saugumą tikrina `resolveStaticPath`. */
  | { kind: "static"; urlPath: string }
  /** SSE prisijungimas — srautą perima adapteris. */
  | { kind: "sse" };

export type UiRouterPorts = {
  dashboardData(uiToken: string): Promise<unknown>;
  listPolicyProposals(): Promise<unknown>;
  proposePolicyChange(body: unknown): Promise<unknown>;
  decidePolicyProposal(verb: "approve" | "reject" | "apply", body: unknown): Promise<unknown>;
  tokenUsage(query: URLSearchParams): Promise<unknown>;
  tokenAnalytics(): Promise<unknown>;
  reliabilityAnalytics(): Promise<unknown>;
  benchmarkReport(): Promise<unknown>;
  workflowBuckets(): Promise<unknown>;
  wavesView(eventLimit: number): Promise<unknown>;
  decideLearningRecommendation(id: string, decision: "approved" | "rejected"): Promise<unknown>;
  openTaskBucketFolder(bucket: string): Promise<boolean>;
  uploadQueueFiles(rawBody: string): Promise<string[]>;
  ensureLoopRunning(): Promise<unknown>;
  requestLoopStop(): Promise<unknown>;
  setRequestedWorkers(body: unknown): Promise<unknown>;
  setSlotMode(workerId: string, body: unknown): Promise<unknown>;
  applyTaskTriage(action: TaskTriageAction, reference: string): Promise<unknown>;
  /** Ar React dist katalogas rastas — be jo statiniai maršrutai neegzistuoja. */
  hasStaticAssets(): boolean;
  /** Klaidos žurnalui; klientui detalės niekada neišeina. */
  logError(message: string): void;
};

export type UiRouterDeps = {
  ports: UiRouterPorts;
  projectRoot: string;
  /** Per-server-start paslaptis. */
  uiToken: string;
  eventLimitFromQuery(query: URLSearchParams): number;
  platform?: NodeJS.Platform;
};

const json = (data: unknown, status = 200): UiRouteResponse => ({ kind: "json", status, data });

function toResponse(error: HttpErrorResponse): UiRouteResponse {
  return error.body ? { kind: "json", status: error.status, data: error.body } : { kind: "text", status: error.status, text: error.text ?? "" };
}

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
    return json({
      schema_version: 1,
      service: UI_IDENTITY_SERVICE,
      project_fingerprint: projectFingerprint(deps.projectRoot, deps.platform ?? process.platform),
    });
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
    case "/api/token-analytics":
      return await guarded(() => ports.tokenAnalytics());
    case "/api/reliability-analytics":
      return await guarded(() => ports.reliabilityAnalytics());
    case "/api/benchmark/report":
      return await guarded(() => ports.benchmarkReport());
    case "/api/tasks":
      return await guarded(() => ports.workflowBuckets());
    case "/api/waves":
      return await guarded(() => ports.wavesView(deps.eventLimitFromQuery(url.searchParams)));
    default:
      return undefined;
  }
}

async function handlePost(
  deps: UiRouterDeps,
  pathname: string,
  request: UiRouteRequest,
): Promise<UiRouteResponse | undefined> {
  const ports = deps.ports;

  const withJsonBody = async (
    run: (body: unknown) => Promise<UiRouteResponse>,
  ): Promise<UiRouteResponse> => {
    let body: unknown;
    try {
      body = await request.readJsonBody();
    } catch (error) {
      return toResponse(mapJsonBodyError(error instanceof Error && error.name === "RequestBodyTooLargeError"));
    }
    try {
      return await run(body);
    } catch (error) {
      ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
      return toResponse(INTERNAL_ERROR_RESPONSE);
    }
  };

  if (pathname === "/tasks/queue/upload") {
    let saved: string[];
    try {
      saved = await ports.uploadQueueFiles(await request.readRawBody());
    } catch (error) {
      return toResponse(mapUploadError(error));
    }
    // Užduotys JAU išsaugotos: loop paleidimo klaida nebepaverčia viso atsakymo 500 — klientas turi
    // sužinoti, kad failai eilėje, net jei loop'as nepasileido.
    let loop: unknown;
    try {
      loop = await ports.ensureLoopRunning();
    } catch (error) {
      loop = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    return json({ saved, loop }, 201);
  }

  if (pathname === "/tasks/resume") {
    return json(await ports.ensureLoopRunning());
  }
  if (pathname === "/tasks/stop") {
    return json(await ports.requestLoopStop());
  }
  if (pathname === "/api/runtime/workers") {
    return await withJsonBody(async (body) => json(await ports.setRequestedWorkers(body)));
  }
  if (pathname === "/api/runtime/loop/start") {
    return json(await ports.ensureLoopRunning());
  }
  if (pathname === "/api/policies/propose") {
    return await withJsonBody(async (body) => json(await ports.proposePolicyChange(body)));
  }

  const decision = /^\/api\/policies\/proposals\/(approve|reject|apply)$/.exec(pathname);
  if (decision?.[1]) {
    const verb = decision[1] as "approve" | "reject" | "apply";
    return await withJsonBody(async (body) => json(await ports.decidePolicyProposal(verb, body)));
  }

  const slotMode = /^\/api\/runtime\/slots\/([^/]+)\/mode$/.exec(pathname);
  if (slotMode?.[1]) {
    const workerId = decodeSegment(slotMode[1]);
    return await withJsonBody(async (body) => json(await ports.setSlotMode(workerId, body)));
  }

  const triage = /^\/api\/tasks\/(requeue|complete)\/(.+)$/.exec(pathname);
  if (triage?.[1] && triage[2]) {
    const action = triage[1] as TaskTriageAction;
    try {
      return json(await ports.applyTaskTriage(action, decodeSegment(triage[2])));
    } catch (error) {
      return toResponse(mapTaskTriageError(error));
    }
  }

  const learning = /^\/learning\/(approve|reject)\/(.+)$/.exec(pathname);
  if (learning?.[1] && learning[2]) {
    const verdict = learning[1] === "approve" ? "approved" : "rejected";
    try {
      return json({ record: await ports.decideLearningRecommendation(decodeSegment(learning[2]), verdict) });
    } catch (error) {
      ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
      return toResponse(INTERNAL_ERROR_RESPONSE);
    }
  }

  const folder = /^\/folders\/open\/(.+)$/.exec(pathname);
  if (folder?.[1]) {
    // Nežinomas bucket'as yra 404, o ne bandymas atidaryti laisvos formos kelią.
    const opened = await ports.openTaskBucketFolder(decodeSegment(folder[1]));
    return { kind: "empty", status: opened ? 204 : 404 };
  }

  return undefined;
}

/** Koduotas segmentas; netinkamas kodavimas grąžina žalią reikšmę, o ne meta. */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
