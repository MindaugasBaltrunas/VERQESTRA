// VQ-601 tolesnis žingsnis — dashboard'as PRIEŠ operatorių: šis testas kelia TIKRĄ kompozicijos
// wiring'ą (ne fake hub'ą kaip `composition-ui-server.test.ts`), kad įrodytų, jog
// `verqestra ui` realiai paleistas serveris atiduoda gyvą SSE srautą per tikrą HTTP jungtį.
//
// `/api/events` maršrutas (`ui-router.ts` `handleGet`) NEKVIEČIA jokio porto — jis tiesiog grąžina
// `{ kind: "sse" }` ir srautą perima hub'as. Tad tuščias `mkdtemp` katalogas kaip
// `projectRoot`/`runtimeRoot`/`agRoot` yra saugus: joks failų skaitymas šiam keliui netaikomas, o
// visi `ssePorts`/`uiRouterPorts` skaitymai gracingai degraduoja, kai failų nėra.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUiToken, UI_TOKEN_HEADER } from "../interfaces/http/ui-security.js";
import { handleUiRequest } from "../interfaces/http/ui-router.js";
import { normalizeEventLimit } from "../interfaces/http/ui-waves-view.js";
import { createSseHub } from "../interfaces/http/sse-service.js";
import { createUiServer, listenUiServer } from "../composition/ui/server.js";
import { ssePorts } from "../composition/ui/sse-adapters.js";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";

test("dashboard'as pakyla ir /api/events atiduoda gyvą SSE kadrą per tikrą HTTP jungtį", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "vq-ui-sse-live-"));
  try {
    const errors: string[] = [];
    const uiToken = createUiToken();

    // TIKRAS wiring, ne testinis pakaitalas: tos pačios funkcijos, kurias sudėlioja
    // `runUiCommand` (composition/ui/command.ts).
    const ports = uiRouterPorts({
      projectRoot: tmpDir,
      runtimeRoot: tmpDir,
      agRoot: tmpDir,
      logError: (message) => errors.push(message),
    });

    const sseHub = createSseHub({
      ...ssePorts({
        projectRoot: tmpDir,
        runtimeRoot: tmpDir,
        logError: (message) => errors.push(message),
      }),
      // Taimeris paduodamas portu (žr. `command.ts`); `unref` — kad testo procesas neliktų kabėti.
      setInterval: (handler, ms) => {
        const timer = setInterval(handler, ms);
        timer.unref();
        return { clear: () => clearInterval(timer) };
      },
    });

    const server = createUiServer({
      route: (request) =>
        handleUiRequest(
          {
            ports,
            projectRoot: tmpDir,
            uiToken,
            eventLimitFromQuery: (query) => normalizeEventLimit(query.get("limit")),
          },
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            readJsonBody: () => Promise.resolve(JSON.parse(request.body === "" ? "null" : request.body) as unknown),
            readRawBody: () => Promise.resolve(request.body),
          },
        ),
      uiToken,
      sse: sseHub,
      logError: (message) => errors.push(message),
    });

    const listening = await listenUiServer(server, 0);
    try {
      const controller = new AbortController();
      try {
        const response = await fetch(`http://127.0.0.1:${listening.port}/api/events`, {
          headers: { [UI_TOKEN_HEADER]: uiToken },
          signal: controller.signal,
        });

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

        const body = response.body;
        assert.ok(body, "SSE atsakymas privalo turėti kūno srautą");
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let collected = "";
        // Kaupiame skaitymus, kol susirenka PILNAS SSE kadras (`data: ...\n\n`). Kiekvienas
        // žingsnis privalo įrodyti, kad srautas savęs pats neuždaro — `done` niekada `true`.
        while (!collected.includes("\n\n")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "SSE srautas neturi užsidaryti savaime");
          collected += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
        }

        // Tikras `data:` kadras su tuščia eilute po jo — ne vien koks nors baitas kanale.
        assert.match(collected, /^data: .+\n\n/);
      } finally {
        // Fetch/SSE jungtis uždaroma PRIEŠ `listening.close()`, kad `node --test` procesas
        // neliktų kabėti laukdamas atviro socket'o.
        controller.abort();
      }
    } finally {
      await listening.close();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
