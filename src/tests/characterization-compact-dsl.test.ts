// VQ-302 characterization (PAR-1): WorkerTaskIR → Compact Worker DSL runner'is prieš
// pažodinę AG_loop fixture kopiją. Render atvejo IR konstruojamas per workerTaskIrSchema.parse
// iš fixture ir_base + overrides (source_sha256 — deterministinis contextArtifactSha256
// ("fixture")), DSL tekstas lyginamas byte-tiksliai kaip eilučių masyvas; kiekvienam render
// atvejui papildomai tvirtinami parity (lossless) ir parse round-trip invariantai.
// Record režimo NĖRA (PAR-1).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderCompactWorkerDsl } from "../application/context-pack/compact-dsl/render.js";
import { parseCompactWorkerDsl } from "../application/context-pack/compact-dsl/parse.js";
import { compactWorkerDslParity } from "../application/context-pack/compact-dsl/parity.js";
import { contextArtifactSha256 } from "../application/context-pack/execution-context-fingerprint.js";
import { workerTaskIrSchema, type WorkerTaskIr } from "../application/context-pack/worker-task-ir-schema.js";

type DslCase = {
  id: string;
  kind: "render" | "parse";
  ir?: Record<string, unknown>;
  text?: string[];
  expect: Record<string, unknown>;
};

type DslFixture = {
  schema_version: number;
  record?: boolean;
  ir_base: Record<string, unknown>;
  cases: DslCase[];
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "compact-worker-dsl.json",
);

const fixture: DslFixture = JSON.parse(await readFile(fixturePath, "utf8"));

function irOf(overrides: Record<string, unknown>): WorkerTaskIr {
  return workerTaskIrSchema.parse({
    ...fixture.ir_base,
    source_sha256: contextArtifactSha256("fixture"),
    ...overrides,
  });
}

function runCase(dslCase: DslCase): unknown {
  if (dslCase.kind === "render") {
    const ir = irOf(dslCase.ir ?? {});
    const dsl = renderCompactWorkerDsl(ir);
    // Invariantai, kurie galioja KIEKVIENAM render atvejui nepriklausomai nuo etalono:
    // render'is pats įrodo lossless round-trip, o parse'as priima savo paties išvestį.
    assert.equal(compactWorkerDslParity(ir, dsl).ok, true, `${dslCase.id}: parity must hold`);
    assert.equal(parseCompactWorkerDsl(dsl.text).ok, true, `${dslCase.id}: own output must parse`);
    return {
      text: dsl.text.split("\n"),
      aliases: dsl.aliases,
      removed_duplicates: dsl.removed_duplicates,
      stats: dsl.stats,
    };
  }
  const parsed = parseCompactWorkerDsl((dslCase.text ?? []).join("\n"));
  if (parsed.ok) return { ok: true };
  return { ok: false, code: parsed.error.code, line: parsed.error.line ?? null };
}

test("compact-dsl characterization fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 9, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const dslCase of fixture.cases) {
  test(`compact-dsl contract: ${dslCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(dslCase)));
    assert.deepStrictEqual(actual, dslCase.expect, dslCase.id);
  });
}
