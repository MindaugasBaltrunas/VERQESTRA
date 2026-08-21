// UI HTTP transporto kiautas (etalonas: AG_loop ui/server.ts transporto pusė).
//
// Maršrutizavimas yra GRYNA funkcija (`interfaces/http/ui-router` — užklausa į atsakymą), tad
// čia lieka tik tai, ko gryna funkcija padaryti negali: socket'as, kūno skaitymas, atsakymo
// rašymas, statiniai failai ir SSE srauto perėmimas.
//
// Sluoksnis yra KOMPOZICIJA, ne infrastructure: kiautas jungia GRYNĄ interfaces maršrutizatorių
// su `node:http`, o `infrastructure → interfaces` kryptis architektūros vartuose uždrausta.
// Būtent tokia siūlė ir yra kompozicijos darbas (pirmas bandymas šį failą dėti į
// `infrastructure/http` krito ties `layer boundaries` vartu — teisingai).
//
// Trys savybės, kurios yra kontraktas, o ne detalė:
//   1. Serveris klauso TIK loopback'e. Prieinamas iš tinklo dashboard'as reikštų, kad bet kas
//      LAN'e gali paleisti loop'ą ir skaityti task'ų turinį — token'as tam nėra pakankama riba.
//   2. Užklausos kūnas turi KIETĄ dydžio lubą. Be jos vienas `POST` be `content-length` gali
//      suvalgyti atmintį, o UI procesas yra tas pats, kuris valdo loop'ą.
//   3. SSE atsakymas NIEKADA neužsidaro pats: srautą perima hub'as, o šis modulis tik atiduoda
//      jam socket'ą su teisingomis antraštėmis.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import {
  resolveStaticPath,
  responseHeaders,
  type RequestHeaders,
} from "../interfaces/http/ui-security.js";
import type { SseHub } from "../interfaces/http/sse-service.js";
import type { UiRouteResponse } from "../interfaces/http/ui-router.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

/**
 * Didžiausias priimamas užklausos kūnas.
 *
 * 8 MiB, nes vienintelis didelis kelias yra task'ų įkėlimas (`/api/queue/upload`), o task'as yra
 * Markdown. Riba tikrinama SKAITANT, ne iš `content-length`: antraštę klientas kontroliuoja.
 */
export const UI_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Užklausos kūnas kaip tekstas.
 *
 * Peržengus ribą ryšys NUTRAUKIAMAS (`destroy`), o ne atsakoma klaida: siuntėjas jau siunčia
 * srautą, ir mandagus atsakymas reikštų, kad likusius baitus vis tiek priimame.
 */
export async function readRequestBody(request: IncomingMessage, maxBytes = UI_MAX_REQUEST_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      request.destroy();
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type UiServerDeps = {
  /** Gryna maršrutizavimo funkcija — visas sprendimų priėmimas gyvena joje. */
  route(request: { method: string; url: string; headers: RequestHeaders; body: string }): Promise<UiRouteResponse>;
  /** React dist katalogas; `undefined`, kai statinių failų nėra (tik API režimas). */
  staticDir?: string;
  sse: SseHub;
  logError(message: string): void;
};

/** Vieno atsakymo išrašymas. Statinio failo nebuvimas virsta 404 — ne 500. */
async function writeResponse(deps: UiServerDeps, response: ServerResponse, route: UiRouteResponse): Promise<void> {
  if (route.kind === "json") {
    const body = JSON.stringify(route.data);
    response.writeHead(route.status, responseHeaders("application/json; charset=utf-8"));
    response.end(body);
    return;
  }
  if (route.kind === "text") {
    response.writeHead(route.status, responseHeaders("text/plain; charset=utf-8"));
    response.end(route.text);
    return;
  }
  if (route.kind === "empty") {
    response.writeHead(route.status, responseHeaders("text/plain; charset=utf-8"));
    response.end();
    return;
  }
  if (route.kind === "sse") {
    // SSE antraštės: be `no-cache` tarpinis buferis laikytų įvykius, o `keep-alive` yra
    // vienintelis dalykas, dėl kurio šis atsakymas apskritai lieka atviras.
    response.writeHead(200, {
      ...responseHeaders("text/event-stream"),
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    await deps.sse.addClient({
      write: (chunk) => response.write(chunk),
      on: (event, listener) => response.on(event, listener),
    });
    return;
  }

  const staticDir = deps.staticDir;
  if (staticDir === undefined) {
    response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
    response.end("not found");
    return;
  }
  // Kelio saugumą sprendžia `resolveStaticPath` (leksinis `..` sutraukimas plius šaknies
  // patikra) — čia jokios savos kelio aritmetikos, kad path traversal turėtų vieną namą.
  const filePath = resolveStaticPath(staticDir, route.urlPath);
  const bytes = filePath === undefined ? undefined : await nodeFsAdapter.readFileBytes(filePath).catch(() => undefined);
  if (filePath === undefined || bytes === undefined) {
    response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
    response.end("not found");
    return;
  }
  response.writeHead(200, responseHeaders(contentTypeFor(filePath)));
  response.end(Buffer.from(bytes));
}

/**
 * Sukuria (bet NEPALEIDŽIA) UI serverį.
 *
 * Atskyrimas nuo `listen` yra sąmoningas: prievado parinkimas turi savo taisykles ir savo
 * gedimų kelius (`ui-port-store`), tad kvietėjas pirma nusprendžia, kur klausyti, ir tik po to
 * paleidžia. Sujungus abu, prievado nesėkmė virstų pusiau sukurtu serveriu.
 */
export function createUiServer(deps: UiServerDeps): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        const body = request.method === "GET" || request.method === "HEAD" ? "" : await readRequestBody(request);
        const route = await deps.route({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers: request.headers,
          body,
        });
        await writeResponse(deps, response, route);
      } catch (error: unknown) {
        // Detalės keliauja TIK į žurnalą: klaidos tekstas gali nešti kelius ir task'ų turinį,
        // o šis serveris kalbasi su naršykle.
        deps.logError(`ui request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) {
          response.writeHead(500, responseHeaders("application/json; charset=utf-8"));
          response.end(JSON.stringify({ error: "internal error" }));
        } else {
          response.end();
        }
      }
    })();
  });
}

export type UiListenResult = { port: number; close(): Promise<void> };

/**
 * Paleidžia serverį TIK ant `127.0.0.1`.
 *
 * Adresas čia yra fiksuotas, o ne konfigūruojamas: „klausyk kitur" nėra nustatymas, kurį būtų
 * galima saugiai duoti — tai sprendimas atverti loop'o valdymą tinklui.
 */
export function listenUiServer(server: Server, port: number): Promise<UiListenResult> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
