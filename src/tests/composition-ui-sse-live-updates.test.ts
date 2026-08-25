// VQ-504 (014-a-02): įrodo TIKRU wiring'u (ne fake hub'u), kad pasikeitus loop būsenai faile
// `runtimeRoot/state/claude-resume.json`, atidarytas GET /api/events SSE srautas atiduoda ANTRĄ
// freimą su pasikeitusia reikšme. `setInterval` portas paduodamas kaip no-op — pokytis
// transliuojamas RANKOMIS per `sseHub.checkAndBroadcast()` (žr. `command.ts:117` komentarą), kad
// testas nepriklausytų nuo 1500ms poll intervalo ar mtime granuliarumo.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUiServer, listenUiServer } from "../composition/ui/server.js";
import { createSseHub } from "../interfaces/http/sse-service.js";
import { ssePorts } from "../composition/ui/sse-adapters.js";

type ParsedFrame = { claudeStatus?: string | null; [key: string]: unknown };

/** Buferizuotas SSE freimų skaitytojas: viename `read()` gali ateiti dalinis arba keli blokai. */
function createFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>): {
  next(): Promise<ParsedFrame>;
} {
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: ParsedFrame[] = [];

  const drainComplete = (): void => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine !== undefined) {
        pending.push(JSON.parse(dataLine.slice("data: ".length)) as ParsedFrame);
      }
      boundary = buffer.indexOf("\n\n");
    }
  };

  return {
    async next(): Promise<ParsedFrame> {
      while (pending.length === 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE srautas užsidarė prieš gaunant freimą");
        buffer += decoder.decode(value, { stream: true });
        drainComplete();
      }
      const frame = pending.shift();
      if (frame === undefined) throw new Error("nėra laukiamo freimo");
      return frame;
    },
  };
}

test("SSE srautas atspindi loop būsenos pasikeitimą claude-resume.json faile", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-ui-sse-"));
  const errors: string[] = [];
  let listening: { port: number; close(): Promise<void> } | undefined;
  const controller = new AbortController();

  try {
    await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
    const resumePath = path.join(runtimeRoot, "state", "claude-resume.json");

    // 1. Pradinė būsena, PRIEŠ atidarant SSE jungtį.
    await writeFile(resumePath, JSON.stringify({ status: "started", task_id: "t1" }), "utf8");

    const sseHub = createSseHub({
      ...ssePorts({ projectRoot: runtimeRoot, runtimeRoot, logError: (message) => errors.push(message) }),
      // Taimeris paduodamas portu tam, kad testas galėtų jį sukti rankomis — žr. `command.ts:117`.
      setInterval: () => ({ clear: () => {} }),
    });

    const server = createUiServer({
      route: (request) =>
        Promise.resolve(request.url === "/api/events" ? { kind: "sse" } : { kind: "empty", status: 404 }),
      uiToken: "test-token",
      sse: sseHub,
      logError: (message) => errors.push(message),
    });
    listening = await listenUiServer(server, 0);

    const response = await fetch(`http://127.0.0.1:${listening.port}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const body = response.body;
    assert.ok(body, "SSE atsakymas privalo turėti kūną");
    const reader = body.getReader();
    const frames = createFrameReader(reader);

    // 2. Pirmas freimas ateina iš `addClient()` pradinės nuotraukos — visada šviežias.
    const frame1 = await frames.next();
    assert.equal(frame1["claudeStatus"], "started");

    // 3. Pakeičiama loop būsena.
    await writeFile(resumePath, JSON.stringify({ status: "running", task_id: "t1" }), "utf8");

    // 4. Pokytis transliuojamas RANKOMIS — pirmas kvietimas visada transliuoja, nes `lastMtimes`
    //    startuoja tuščias, tad nepriklauso nuo OS mtime granuliarumo.
    await sseHub.checkAndBroadcast();

    // 5. Antras freimas iš TO PATIES reader'io — turi atspindėti pasikeitusią būseną.
    const frame2 = await frames.next();
    assert.equal(frame2["claudeStatus"], "running");

    assert.notEqual(frame1["claudeStatus"], frame2["claudeStatus"]);
  } finally {
    controller.abort();
    if (listening !== undefined) await listening.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
