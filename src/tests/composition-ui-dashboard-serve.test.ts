// VQ testai — dashboard'o pateikimas per TIKRĄ `listenUiServer` kelią.
//
// `composition-ui-server.test.ts` jau 1:1 dengia app shell'o token'o įrašymą (SPA maršrutas su
// realiu `index.html`) ir 503 atsakymą su `UI_BUILD_COMMAND`, kai build'o nėra — abu per tą patį
// `createUiServer` + `listenUiServer(server, 0)` kelią. Šis failas TO nekartoja pilnai: jis prideda
// tai, ko joks esamas testas netikrina eksplicitiškai — kad realiai paleistas serveris (per
// `server.address()`, ne per hardkodintą `127.0.0.1` fetch URL) tikrai klauso TIK loopback'e, o
// ne `0.0.0.0`. Smoke testai #1/#2 paliekami minimalūs, kad failas savarankiškai patvirtintų abu
// acceptance kriterijus be pilno esamo failo dubliavimo.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import type { SseHub } from "../interfaces/http/sse-service.js";
import { UI_BUILD_COMMAND, createUiServer, listenUiServer } from "../composition/ui/server.js";

/** Hub'o pakaitalas: šiam failui SSE elgesys nerūpi, tik tai, kad priklausomybė patenkinta. */
function fakeHub(): SseHub {
  return {
    addClient: (client) => {
      client.write(": connected\n\n");
      return Promise.resolve();
    },
    clientCount: () => 0,
    checkAndBroadcast: () => Promise.resolve(),
  };
}

test("listenUiServer: realiai paleistas serveris klauso TIK 127.0.0.1, ne 0.0.0.0", async () => {
  const server = createUiServer({
    route: () => Promise.resolve({ kind: "empty", status: 204 }),
    uiToken: "test-token",
    sse: fakeHub(),
    logError: () => {},
  });
  const listening = await listenUiServer(server, 0);
  try {
    // `UiListenResult` grąžina tik `{ port, close() }` — adreso jame nėra. Todėl adresą tikriname
    // TIESIOGIAI per `server` objektą, kurį gavome iš `createUiServer`, o ne per fetch URL, kuris
    // hardkodina `127.0.0.1` ir todėl niekada neįrodytų, kad serveris klauso būtent ten.
    const address = server.address() as AddressInfo | string | null;
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const info = address as AddressInfo;
    assert.equal(info.address, "127.0.0.1");
    assert.notEqual(info.address, "0.0.0.0");
    assert.equal(info.port, listening.port);
  } finally {
    await listening.close();
  }
});

test("dashboard'as: su realiu build'u GET / grąžina 200 su įrašytu UI token'u", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "vq-ui-dashboard-serve-"));
  try {
    const distDir = path.join(sandbox, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(distDir, "index.html"),
      '<!doctype html><meta name="vq-ui-token" content="" /><div id="root"></div>',
      "utf8",
    );

    const server = createUiServer({
      route: (request) => Promise.resolve({ kind: "static", urlPath: new URL(request.url, "http://127.0.0.1").pathname }),
      staticDir: distDir,
      uiToken: "DASHBOARD-TOKENAS",
      sse: fakeHub(),
      logError: () => {},
    });
    const listening = await listenUiServer(server, 0);
    try {
      const response = await fetch(`http://127.0.0.1:${listening.port}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await response.text(), /<meta name="vq-ui-token" content="DASHBOARD-TOKENAS"/);
    } finally {
      await listening.close();
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("dashboard'as: be build'o GET / grąžina komandą per UI_BUILD_COMMAND konstantą", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "vq-ui-dashboard-nobuild-"));
  try {
    const distDir = path.join(sandbox, "dist");
    await mkdir(distDir, { recursive: true });

    const server = createUiServer({
      route: (request) => Promise.resolve({ kind: "static", urlPath: new URL(request.url, "http://127.0.0.1").pathname }),
      staticDir: distDir,
      uiToken: "test-token",
      sse: fakeHub(),
      logError: () => {},
    });
    const listening = await listenUiServer(server, 0);
    try {
      const response = await fetch(`http://127.0.0.1:${listening.port}/`);
      assert.equal(response.status, 503);
      assert.ok((await response.text()).includes(UI_BUILD_COMMAND));
    } finally {
      await listening.close();
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
