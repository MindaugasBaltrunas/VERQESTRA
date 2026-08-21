// VQ-504 (34/N) testai — UI transporto kiautas ant TIKRO `node:http` serverio.
//
// Tikrinama tai, ko gryna maršrutizavimo funkcija patikrinti negali: kūno riba, atsakymų formos,
// statinių failų path traversal ir SSE ryšys, kuris privalo likti ATVIRAS.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SseHub } from "../interfaces/http/sse-service.js";
import type { UiRouteResponse } from "../interfaces/http/ui-router.js";
import { UI_MAX_REQUEST_BODY_BYTES, createUiServer, listenUiServer } from "../composition/ui-server.js";

/** Hub'o pakaitalas: kiautui rūpi tik tai, kad klientas jam perduodamas. */
function fakeHub(): { hub: SseHub; clients: number } {
  const state = { clients: 0 };
  const hub: SseHub = {
    addClient: (client) => {
      state.clients += 1;
      client.write(": connected\n\n");
      return Promise.resolve();
    },
    clientCount: () => state.clients,
    checkAndBroadcast: () => Promise.resolve(),
  };
  return {
    hub,
    get clients() {
      return state.clients;
    },
  };
}

async function withServer(
  route: (request: { method: string; url: string; body: string }) => UiRouteResponse,
  options: { staticDir?: string } = {},
  run: (base: string, hub: { clients: number }) => Promise<void> = async () => {},
): Promise<void> {
  const errors: string[] = [];
  const hub = fakeHub();
  const server = createUiServer({
    route: (request) => Promise.resolve(route(request)),
    ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
    sse: hub.hub,
    logError: (message) => errors.push(message),
  });
  const listening = await listenUiServer(server, 0);
  try {
    await run(`http://127.0.0.1:${listening.port}`, hub);
  } finally {
    await listening.close();
  }
}

test("json/text/empty atsakymai gauna saugumo antraštes", async () => {
  await withServer(
    (request) =>
      request.url === "/json"
        ? { kind: "json", status: 200, data: { ok: true } }
        : request.url === "/text"
          ? { kind: "text", status: 418, text: "arbatinukas" }
          : { kind: "empty", status: 204 },
    {},
    async (base) => {
      const json = await fetch(`${base}/json`);
      assert.equal(json.status, 200);
      assert.deepEqual(await json.json(), { ok: true });
      // Antraštės yra dalis kontrakto: be `nosniff` naršyklė gali spėti tipą už mus.
      assert.equal(json.headers.get("x-content-type-options"), "nosniff");
      assert.ok(json.headers.get("content-security-policy"));

      const text = await fetch(`${base}/text`);
      assert.equal(text.status, 418);
      assert.equal(await text.text(), "arbatinukas");

      assert.equal((await fetch(`${base}/empty`)).status, 204);
    },
  );
});

test("POST kūnas pasiekia maršrutizatorių", async () => {
  let seen = "";
  await withServer(
    (request) => {
      seen = request.body;
      return { kind: "json", status: 200, data: { length: request.body.length } };
    },
    {},
    async (base) => {
      const response = await fetch(`${base}/api/x`, { method: "POST", body: "labas" });
      assert.deepEqual(await response.json(), { length: 5 });
      assert.equal(seen, "labas");
    },
  );
});

test("per didelis kūnas nutraukia ryšį, o ne priimamas iki galo", async () => {
  let routed = 0;
  await withServer(
    () => {
      routed += 1;
      return { kind: "json", status: 200, data: {} };
    },
    {},
    async (base) => {
      const oversized = "x".repeat(UI_MAX_REQUEST_BODY_BYTES + 1024);
      await assert.rejects(
        () => fetch(`${base}/api/queue/upload`, { method: "POST", body: oversized }),
        "ryšys turi būti nutrauktas",
      );
      // Svarbiausia: maršrutizatorius NEPASIEKIAMAS — kūnas atmestas dar skaitant.
      assert.equal(routed, 0);
    },
  );
});

test("statinis failas atiduodamas, o kelias UŽ dist ribų — 404", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "vq-ui-static-"));
  try {
    const distDir = path.join(sandbox, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "index.html"), "<!doctype html>labas", "utf8");
    await writeFile(path.join(sandbox, "slaptas.txt"), "SVETIMAS", "utf8");

    await withServer(
      (request) => ({ kind: "static", urlPath: new URL(request.url, "http://127.0.0.1").pathname }),
      { staticDir: distDir },
      async (base) => {
        const ok = await fetch(`${base}/index.html`);
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /labas/);
        assert.match(ok.headers.get("content-type") ?? "", /text\/html/);

        // Path traversal: `..` sutraukiamas leksiškai ir rezultatas tikrinamas prieš šaknį.
        const escaped = await fetch(`${base}/../slaptas.txt`);
        assert.equal(escaped.status, 404);
        assert.doesNotMatch(await escaped.text(), /SVETIMAS/);

        assert.equal((await fetch(`${base}/nera.js`)).status, 404);
      },
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("SSE atsakymas perduodamas hub'ui ir LIEKA atviras", async () => {
  await withServer(
    () => ({ kind: "sse" }),
    {},
    async (base, hub) => {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(response.headers.get("cache-control"), "no-cache");

      // Pirmas baitas ateina, bet srautas NEUŽSIDARO — tai ir yra SSE esmė.
      const reader = response.body?.getReader();
      const first = await reader?.read();
      assert.equal(first?.done, false);
      assert.equal(hub.clients, 1);
      controller.abort();
    },
  );
});

test("maršrutizatoriaus išimtis virsta 500 BE detalių", async () => {
  await withServer(
    () => {
      throw new Error("slaptas kelias D:/vq/state/secret.json");
    },
    {},
    async (base) => {
      const response = await fetch(`${base}/api/x`);
      assert.equal(response.status, 500);
      const text = await response.text();
      // Klaidos tekstas gali nešti kelius ir task'ų turinį — klientui jis neišeina.
      assert.doesNotMatch(text, /secret\.json/);
      assert.match(text, /internal error/);
    },
  );
});
