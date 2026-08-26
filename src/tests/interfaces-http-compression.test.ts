// Kompresijos vėliavų endpoint'as: vaizdas + vienos vėliavos perjungimas (2026-08-26).
//
// Ką šie testai prikala:
//   1. `canary_supported` ateina iš DOMENO registro — UI negali pasiūlyti reikšmės, kurią
//      serveris atmes (`bash_output_digest` canary nepalaiko).
//   2. Telemetrija gniūžta ATSKIRAI: sugadintas ar nesantis žurnalas nepaslepia vėliavų.
//   3. Rašymas eina per domeno validatorių, tad nežinomas raktas ir neleistina reikšmė yra
//      KLIENTO klaidos, o ne tyliai priimtos reikšmės.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompressionView,
  parseContextSizeSamples,
  summarizeContextSizeSamples,
} from "../interfaces/http/ui-compression-view.js";
import {
  InvalidCompressionRequestError,
  setCompressionFeature,
} from "../interfaces/http/ui-compression-mutation.js";
import {
  defaultContextCompressionConfig,
  parseContextCompressionConfig,
  type ContextCompressionConfig,
} from "../domain/policies/compression/features.js";

function config(overrides: Partial<ContextCompressionConfig["features"]> = {}): ContextCompressionConfig {
  const base = defaultContextCompressionConfig();
  return { ...base, features: { ...base.features, ...overrides } };
}

const SAMPLE = {
  ts: "2026-08-26T08:25:57.730Z",
  context_chars: 7042,
  max_context_chars: 12000,
  raw_task_chars: 964,
  compiled_task_chars: 1686,
  exceeded: false,
};

test("buildCompressionView: visos penkios vėliavos, canary ribos iš DOMENO registro", async () => {
  const view = await buildCompressionView({
    loadConfig: async () => config({ symbol_slices: "canary" }),
    readContextSizeLog: async () => JSON.stringify(SAMPLE),
  });

  assert.deepEqual(
    view.features.map((feature) => feature.key),
    ["worker_task_ir", "compact_dsl", "symbol_slices", "bash_output_digest", "dispatch_tool_schema"],
    "tvarka deterministinė — ji yra registro, ne šio vaizdo, savybė",
  );
  assert.equal(view.features.find((f) => f.key === "symbol_slices")?.value, "canary");

  // `bash_output_digest` sprendimo taškas neturi task konteksto, tad canary ten NEGALIMAS.
  assert.equal(view.features.find((f) => f.key === "bash_output_digest")?.canary_supported, false);
  assert.equal(view.features.find((f) => f.key === "worker_task_ir")?.canary_supported, true);
  assert.deepEqual(view.degraded, []);
});

test("buildCompressionView: telemetrijos lūžis NEPASLEPIA vėliavų", async () => {
  const missing = await buildCompressionView({
    loadConfig: async () => config(),
    readContextSizeLog: async () => undefined,
  });
  assert.equal(missing.features.length, 5, "vėliavos yra vienintelis dalykas, be kurio puslapis beprasmis");
  assert.equal(missing.telemetry.sample_count, 0);
  assert.match(missing.degraded[0] ?? "", /context-size\.jsonl: not found/);

  const throwing = await buildCompressionView({
    loadConfig: async () => config(),
    readContextSizeLog: async () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(throwing.features.length, 5);
  assert.match(throwing.degraded[0] ?? "", /EACCES/);
});

test("parseContextSizeSamples: sugadinta eilutė praleidžiama, imama UODEGA", () => {
  const raw = [
    JSON.stringify({ ts: "a", context_chars: 1 }),
    "{ nutrūkusi eilutė",
    "",
    JSON.stringify({ ts: "b", context_chars: 2 }),
  ].join("\n");

  const samples = parseContextSizeSamples(raw);
  assert.equal(samples.length, 2, "viena sugadinta eilutė nėra lūžis — rašymas vyksta lygiagrečiai");

  const limited = parseContextSizeSamples(raw, 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0]?.ts, "b", "imamos NAUJAUSIOS");
});

test("summarizeContextSizeSamples: biudžetas, viršijimai ir SHADOW IR palyginimas", () => {
  const summary = summarizeContextSizeSamples([
    SAMPLE,
    { ...SAMPLE, context_chars: 12600, exceeded: true, raw_task_chars: 2000, compiled_task_chars: 1000 },
  ]);

  assert.equal(summary.sample_count, 2);
  assert.equal(summary.exceeded_count, 1, "bet koks viršijimas yra signalas, ne triukšmas");
  assert.equal(summary.max_budget_percent, 105);

  // IR palyginimas: pirmas pavyzdys DIDESNIS (964 → 1686), antras mažesnis (2000 → 1000).
  assert.equal(summary.ir_compared_count, 2);
  assert.equal(summary.ir_smaller_count, 1, "įjungti be šito skaičiaus būtų spėjimas");
  assert.equal(summary.avg_ir_delta_percent, 12.5, "vidurkis tarp +74.9% ir −50%");
});

test("setCompressionFeature: reikšmė įrašoma, o VISAS objektas pervaromas per validatorių", async () => {
  let written: string | undefined;
  const result = await setCompressionFeature(
    {
      loadConfig: async () => config(),
      writeConfig: async (serialized) => void (written = serialized),
    },
    "compact_dsl",
    "canary",
  );

  assert.equal(result.features.compact_dsl, "canary");
  assert.equal(result.features.worker_task_ir, false, "kitos vėliavos nepaliestos");
  assert.ok(written?.endsWith("\n"), "failas baigiasi nauja eilute");
  // Įrašytas tekstas privalo būti perskaitomas TUO PAČIU validatoriumi, kuris jį patvirtino.
  assert.equal(parseContextCompressionConfig(JSON.parse(written ?? "")).features.compact_dsl, "canary");
});

test("setCompressionFeature: nežinomas raktas ir neleistina reikšmė yra KLIENTO klaidos", async () => {
  const ports = {
    loadConfig: async () => config(),
    writeConfig: async () => {
      throw new Error("rašymas neturi būti pasiektas");
    },
  };

  await assert.rejects(
    () => setCompressionFeature(ports, "nera_tokios", true),
    (error: Error) => error instanceof InvalidCompressionRequestError && /unknown feature/.test(error.message),
  );

  await assert.rejects(
    () => setCompressionFeature(ports, "compact_dsl", "taip"),
    (error: Error) => error instanceof InvalidCompressionRequestError && /must be true, false/.test(error.message),
  );
});

test("setCompressionFeature: canary ten, kur jo nėra, ATMETAMAS domeno taisykle", async () => {
  await assert.rejects(
    () =>
      setCompressionFeature(
        {
          loadConfig: async () => config(),
          writeConfig: async () => {
            throw new Error("rašymas neturi būti pasiektas");
          },
        },
        "bash_output_digest",
        "canary",
      ),
    // Verdiktą priima `parseContextCompressionConfig`, ne mutacijos failas: viena taisyklė, vienas atsakymas.
    (error: Error) => /validation failed:.*does not support "canary"/s.test(error.message),
  );
});
