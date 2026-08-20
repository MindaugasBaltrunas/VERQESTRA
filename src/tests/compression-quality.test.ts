// Compression rollout vartų testai (VQ-305 3/3-e). Elgesio etalonas: AG_loop
// tests/compression-quality-gate.test.ts (sutrauktas iki portų lygio scenarijų).
// Windows pastaba: absoliutūs fixture raktai vedami per ROOT/abs(), nes path.resolve
// prideda disko raidę; fake fs normalizuoja backslash'us.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  COMPRESSION_CONFIG_SOURCE,
  canonicalCompressionJson,
  computeCompressionConfigDigest,
} from "../application/release-readiness/compression-config-digest.js";
import { checkCompressionQuality } from "../application/release-readiness/compression-quality-check.js";
import {
  describeCompressionQuality,
  type CompressionQualityFsPort,
} from "../application/release-readiness/compression-quality-model.js";

const ROOT = path.resolve("/repo");
const abs = (rel: string): string => path.join(ROOT, rel).replace(/\\/g, "/");
const RUNTIME_ROOT = path.join(ROOT, "vq");

function fakeFs(files: Record<string, string>): CompressionQualityFsPort {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const store = new Map(Object.entries(files));
  return {
    readTextFileIfExists: async (p) => store.get(norm(p)),
    readFileBytes: async (p) => {
      const text = store.get(norm(p));
      if (text === undefined) throw new Error(`absent: ${p}`);
      return new TextEncoder().encode(text);
    },
    exists: async (p) => store.has(norm(p)),
    appendTextFile: async (p, text) => {
      store.set(norm(p), (store.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, content) => {
      store.set(norm(p), content);
    },
    makeDirectory: async () => {},
    statPath: async (p) => {
      const key = norm(p);
      const text = store.get(key);
      if (text !== undefined) return { kind: "file" as const, size: text.length };
      const dir = key.endsWith("/") ? key : `${key}/`;
      if ([...store.keys()].some((stored) => stored.startsWith(dir))) {
        return { kind: "directory" as const, size: 0 };
      }
      return { kind: "absent" as const, size: 0 };
    },
    readTextFile: async (p) => {
      const text = store.get(norm(p));
      if (text === undefined) throw new Error(`absent: ${p}`);
      return text;
    },
    listDirectory: async (p) => {
      const dir = norm(p).endsWith("/") ? norm(p) : `${norm(p)}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(dir)) names.add(key.slice(dir.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

const OPTIONS = { projectRoot: "/repo", runtimeRoot: RUNTIME_ROOT };

const ENABLED_DOC = {
  version: 1,
  features: { symbol_slices: true },
  canary: { percent: 100, salt: "s" },
};

function reportJson(variantVerdict: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: "improved",
    verdictBasis: "comparison",
    reasons: [],
    current: {
      identity: { suiteHash: "suite", configHash: "", policyHash: "", agCommit: "abc1234def0" },
      sampleCount: 3,
    },
    modes: [],
    scenarios: [],
    limitations: [],
    reproduction: { command: "pnpm --dir AG/benchmark benchmark:report" },
    compression: {
      registryVersion: 1,
      baselineVariantId: "baseline",
      variants: [
        {
          variantId: "v-sym",
          variantIdentity: "identity",
          features: ["symbol_slices"],
          hookProfile: "wired",
          verdict: variantVerdict,
        },
      ],
    },
  });
}

function sidecarJson(document: unknown): string {
  return JSON.stringify({
    schemaVersion: 2,
    runId: "20260801T000000-r1",
    compressionConfig: {
      state: "read",
      source: COMPRESSION_CONFIG_SOURCE,
      digest: computeCompressionConfigDigest(document),
    },
  });
}

const TELEMETRY_LINE = `${JSON.stringify({
  ts: "2026-08-01T00:00:00.000Z",
  task_id: "T-1",
  context_chars: 10,
  max_context_chars: 100,
  canary_features: ["symbol_slices"],
})}\n`;

function fullEvidenceFiles(variantVerdict = "accepted"): Record<string, string> {
  return {
    [abs("vq/config/context-compression.json")]: JSON.stringify(ENABLED_DOC),
    [abs("AG/benchmark/reports/benchmark-report.json")]: reportJson(variantVerdict),
    [abs("AG/benchmark/results/runs/20260801T000000-r1.identity.json")]: sidecarJson(ENABLED_DOC),
    [abs("vq/logs/context-size.jsonl")]: TELEMETRY_LINE,
  };
}

test("kanoninis digest'as nepriklauso nuo raktų tvarkos, o -0 sulyginamas su 0", () => {
  assert.equal(
    computeCompressionConfigDigest({ b: 1, a: 2 }),
    computeCompressionConfigDigest({ a: 2, b: 1 }),
  );
  assert.equal(canonicalCompressionJson({ x: -0 }), '{"x":0}');
  assert.throws(() => canonicalCompressionJson([undefined]), /a list has no holes/);
});

test("be jokios įjungtos vėliavos — vakuuminis pass be benchmark artefaktų", async () => {
  const result = await checkCompressionQuality(fakeFs({}), OPTIONS);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.enabled_features, []);
  assert.equal(result.config_digest, "");
  assert.equal(describeCompressionQuality(result), "ok (no compression feature enabled)");
});

test("įjungta vėliava be AG/benchmark paketo — vienas missing-verdict issue ir stop", async () => {
  const files = { [abs("vq/config/context-compression.json")]: JSON.stringify(ENABLED_DOC) };
  const result = await checkCompressionQuality(fakeFs(files), OPTIONS);
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["missing-verdict"]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!, /AG\/benchmark is not part of this installation/);
});

test("pilni įrodymai — priimtas verdiktas, sutampantis digest'as ir canary telemetrija leidžia pass", async () => {
  const result = await checkCompressionQuality(fakeFs(fullEvidenceFiles()), OPTIONS);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.enabled_features, ["symbol_slices"]);
  assert.equal(describeCompressionQuality(result), "ok (symbol_slices)");
});

test("atmestas varianto verdiktas blokuoja ir cituoja, ką raportas SAKO", async () => {
  const result = await checkCompressionQuality(fakeFs(fullEvidenceFiles("rejected")), OPTIONS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["missing-verdict"]);
  assert.match(result.issues[0]!, /v-sym: rejected/);
});

test("kitos konfigūracijos sidecar'as — stale-identity", async () => {
  const files = fullEvidenceFiles();
  files[abs("AG/benchmark/results/runs/20260801T000000-r1.identity.json")] = sidecarJson({
    version: 1,
    features: {},
    canary: { percent: 0, salt: "" },
  });
  const result = await checkCompressionQuality(fakeFs(files), OPTIONS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["stale-identity"]);
  assert.match(result.issues[0]!, /none of them records the compression configuration digest/);
});

test("loop'o areštuota canary blokuoja release net be įjungtų vėliavų", async () => {
  const files = {
    [abs("vq/config/context-compression.json")]: JSON.stringify({
      version: 1,
      features: { symbol_slices: "canary" },
      canary: { percent: 100, salt: "s" },
    }),
    [abs("vq/state/context-compression-arrest.json")]: JSON.stringify({
      version: 1,
      arrests: [
        {
          feature: "symbol_slices",
          trigger: "fallback-streak",
          reason: "3 consecutive canary fallbacks",
          observed: 3,
          threshold: 3,
          arrested_at: "2026-08-01T00:00:00.000Z",
          last_task_id: "T-9",
        },
      ],
      counters: { fallback_streak: {}, human_review: {}, human_review_task_ids: [] },
    }),
  };
  const result = await checkCompressionQuality(fakeFs(files), OPTIONS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["canary-arrested"]);
  assert.deepEqual(result.arrested_features, ["symbol_slices"]);
  assert.match(result.issues[0]!, /fallback-streak guardrail \(3\/3\)/);
});

test("savo progas turėjusi ir niekad nepritaikyta canary — warning, ne blokas", async () => {
  const silentTelemetry = Array.from({ length: 10 }, (_, index) =>
    JSON.stringify({ task_id: `T-${index}`, context_chars: 10, max_context_chars: 100 }),
  ).join("\n");
  const files = {
    [abs("vq/config/context-compression.json")]: JSON.stringify({
      version: 1,
      features: { symbol_slices: "canary" },
      canary: { percent: 100, salt: "s" },
    }),
    [abs("vq/logs/context-size.jsonl")]: `${silentTelemetry}\n`,
  };
  const result = await checkCompressionQuality(fakeFs(files), OPTIONS);
  assert.equal(result.ok, true);
  assert.equal(result.status, "warning");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /canary-not-observed/);
  assert.match(describeCompressionQuality(result), /1 warning\(s\)$/);
});
