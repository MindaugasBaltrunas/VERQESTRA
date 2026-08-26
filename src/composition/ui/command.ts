// `verqestra ui` — dashboard'o serverio įėjimas (manual DI, LAY-2).
//
// Čia sueina trys atskirai migruoti gabalai: GRYNAS maršrutizatorius (`interfaces/http`), jo
// portų adapteriai (`ui-router-adapters`) ir transporto kiautas (`ui-server`). Šis failas jų
// neplečia — jis tik nusprendžia PRIEVADĄ ir paleidžia.
//
// Prievado parinkimas yra atskiras žingsnis su savo gedimų keliais: porte gali klausyti MŪSŲ
// serveris (tada naujo nestatome ir grąžiname esamą URL) arba SVETIMAS procesas (tada imame
// kitą kandidatą). Tas skirtumas gyvena `ui-port-store`; čia lieka tik trys baigtys.

import { createConnection } from "node:net";
import path from "node:path";
import { handleUiRequest } from "../../interfaces/http/ui-router.js";
import { normalizeEventLimit } from "../../interfaces/http/ui-waves-view.js";
import { createUiToken } from "../../interfaces/http/ui-security.js";
import { resolveUiPort, writeUiServerRecord, type UiPortPorts } from "../../interfaces/http/ui-port-store.js";
import type { UiPortProbeResult } from "../../interfaces/http/ui-port-rules.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { createUiServer, listenUiServer } from "./server.js";
import { createSseHub } from "../../interfaces/http/sse-service.js";
import { ssePorts } from "./sse-adapters.js";
import { uiRouterPorts } from "./router-adapters.js";
import { packageRoot } from "../runtime/context.js";
import type { CliRegistryDeps } from "../cli/registry-types.js";

/** Kiek laukiama kandidato atsako; ilgesnis laukimas paverstų startą minučių operacija. */
const PORT_PROBE_TIMEOUT_MS = 300;

/**
 * Vieno prievado zondas.
 *
 * FAIL-CLOSED: bet koks neaiškumas (timeout, netikėta klaida) reiškia `occupied` BE
 * `fingerprint`, t. y. „kažkas ten yra, ir tai ne mes". Priešinga prielaida leistų dviem UI
 * serveriams atsidurti ant to paties prievado, o antrasis tyliai perrašytų pirmojo įrašą.
 */
export function probeUiPort(port: number): Promise<UiPortProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (result: UiPortProbeResult): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish({ state: "occupied" }));
    // ECONNREFUSED yra VIENINTELIS aiškus „laisva": niekas neklauso.
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? { state: "free" } : { state: "occupied" }),
    );
    socket.once("timeout", () => finish({ state: "occupied" }));
  });
}

/**
 * Porto sprendimo portai. Eksportuojami, nes juos naudoja DU keliai: pati `ui` komanda ir
 * `verqestra loop` autostart'as. Antra kopija reikštų du skirtingus atsakymus apie tą patį
 * prievadą, o būtent porto tapatybė yra tai, kas skiria „mūsų serveris" nuo „svetimas procesas".
 */
export const uiPortPorts: UiPortPorts = {
  fs: {
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
    makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  },
  env: (name) => process.env[name],
  probe: (port) => probeUiPort(port),
};

/** React dist katalogas arba `undefined`, kai jo nėra (tik API režimas). */
async function resolveStaticDir(): Promise<string | undefined> {
  const candidate = path.join(packageRoot(), "ui-app", "dist");
  return (await nodeFsAdapter.statKind(candidate)) === "directory" ? candidate : undefined;
}

export type UiCommandIo = { out(line: string): void; error(line: string): void };

/**
 * Paleidžia dashboard'ą ir GRĄŽINA tik tada, kai serveris nustoja klausyti.
 *
 * Token'as generuojamas per KIEKVIENĄ startą: jis gyvena tik šio proceso atmintyje ir įraše,
 * tad perkrautas serveris nebepriima senų naršyklės skirtukų — o tai yra savybė, ne trūkumas.
 */
export async function runUiCommand(deps: CliRegistryDeps, io: UiCommandIo): Promise<number> {
  const resolution = await resolveUiPort({
    ports: uiPortPorts,
    projectRoot: deps.roots.projectRoot,
    runtimeRoot: deps.roots.runtimeRoot,
  });

  if (resolution.status === "failed") {
    io.error(`ui: ${resolution.reason}`);
    return 1;
  }
  if (resolution.status === "already-running") {
    // Antro serverio NESTATOME: jis perrašytų įrašą, ir operatoriaus nuoroda rodytų į procesą,
    // kurio niekas nebevaldo.
    io.out(`ui already running: ${resolution.url}`);
    return 0;
  }

  const staticDir = await resolveStaticDir();
  const uiToken = createUiToken();
  const ports = uiRouterPorts({
    projectRoot: deps.roots.projectRoot,
    runtimeRoot: deps.roots.runtimeRoot,
    agRoot: deps.roots.agRoot,
    ...(staticDir === undefined ? {} : { staticDir }),
    logError: (message) => io.error(message),
  });

  const sseHub = createSseHub({
    ...ssePorts({
      projectRoot: deps.roots.projectRoot,
      runtimeRoot: deps.roots.runtimeRoot,
      logError: (message) => io.error(message),
    }),
    // Taimeris paduodamas portu: hub'as pats laiko neskaito, tad jį galima sukti testuose.
    setInterval: (handler, ms) => {
      const timer = setInterval(handler, ms);
      // `unref`: srauto taimeris negali laikyti proceso gyvo po serverio užsidarymo.
      timer.unref();
      return { clear: () => clearInterval(timer) };
    },
  });

  const server = createUiServer({
    route: (request) =>
      handleUiRequest(
        {
          ports,
          projectRoot: deps.roots.projectRoot,
          uiToken,
          eventLimitFromQuery: (query) => normalizeEventLimit(query.get("limit")),
        },
        {
          method: request.method,
          url: request.url,
          headers: request.headers,
          // Kūnas jau perskaitytas transporto kiaute (su kieta dydžio luba), tad čia jis tik
          // paduodamas. Netinkamas JSON META — maršrutizatorius tai verčia 400, ne 500.
          readJsonBody: () => Promise.resolve(JSON.parse(request.body === "" ? "null" : request.body) as unknown),
          readRawBody: () => Promise.resolve(request.body),
        },
      ),
    ...(staticDir === undefined ? {} : { staticDir }),
    // Tas pats token'as, kurį tikrina maršrutizatorius: shell'as jį atiduoda naršyklei, o ji
    // grąžina antraštėje. Dvi reikšmės čia reikštų, kad puslapis niekada neprisijungia.
    uiToken,
    // Hub'as sukuriamas VIENAS: taimeriai ir stebimų failų žymės yra jo būsena, o du
    // egzemplioriai tą pačią eilutę transliuotų dukart.
    sse: sseHub,
    logError: (message) => io.error(message),
  });

  const listening = await listenUiServer(server, resolution.port);
  await writeUiServerRecord(uiPortPorts, path.join(deps.roots.runtimeRoot, "state"), {
    port: listening.port,
    fingerprint: resolution.fingerprint,
    pid: process.pid,
  });

  io.out(`ui listening: http://127.0.0.1:${listening.port}`);
  if (staticDir === undefined) io.out("ui: static assets not found — API only");

  // Serveris laiko proceso event loop'ą gyvą; komanda baigiasi, kai jis užsidaro.
  await new Promise<void>((resolve) => server.once("close", () => resolve()));
  return 0;
}
