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
import { persistContextPack } from "../application/context-pack/assemble/persist.js";
import { contextSizeMetricsLogPath } from "../application/context-pack/metrics.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";

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

// Task 036-d-05 made persist.ts shadow-render the compact worker DSL into the context-size log;
// task 155 removed that writer once the 204-sample answer was in. The fixture port below stays,
// because the invariant worth guarding flipped rather than disappeared.
function memoryFs(): ContextPackFileSystemPort {
  const store = new Map<string, string>();
  return {
    async readTextFileIfExists(absolutePath) {
      return store.get(path.resolve(absolutePath));
    },
    async readFileBytes(absolutePath) {
      const value = store.get(path.resolve(absolutePath));
      if (value === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return new TextEncoder().encode(value);
    },
    async exists(absolutePath) {
      return store.has(path.resolve(absolutePath));
    },
    async appendTextFile(absolutePath, text) {
      const key = path.resolve(absolutePath);
      store.set(key, (store.get(key) ?? "") + text);
    },
    async writeTextFile(absolutePath, content) {
      store.set(path.resolve(absolutePath), content);
    },
    async makeDirectory() {
      // in-memory — nėra ką kurti
    },
  };
}

const COMPILABLE_TASK = [
  "# Task",
  "",
  "## Tikslas",
  "Ilgas tikslas su pakankamai teksto ir keliais keliais, kad DSL alias'ai turėtų ką aliasinti.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "- `src/module/b.ts`",
  "Draudžiama:",
  "- `.env*`",
  "",
  "## Veiksmas",
  "- Pirmas žingsnis.",
  "- Antras žingsnis.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai patikros žalios, sustok.",
  "",
].join("\n");

function packFor(taskId: string, goal: string, allowedPaths: string[], checks: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    phase: "implementation",
    goal,
    allowed_paths: allowedPaths,
    agents: [],
    spec_fragments: [],
    spec_fragment_warnings: [],
    spec_fragment_truncated: [],
    acceptance_criteria: [],
    architecture_rules: [],
    checks,
    out_of_scope: [],
  };
}

// Task 155 inverts 036-d-05: persist.ts no longer shadow-renders the compact DSL at all, so the
// pair is absent even for a task the renderer would happily compile. The parity fixture above is
// untouched — the renderer itself still has to satisfy AG_loop byte for byte; what changed is
// only that context-pack assembly stopped paying for a measurement whose answer is known.
test("persistContextPack: the compact-dsl shadow pair is no longer written, even for a fully compilable task", async () => {
  const runtimeRoot = path.resolve("vq-test-root-036d05-compact-dsl");
  const fs = memoryFs();
  const pack = packFor("036d05-compilable", "Ilgas tikslas su pakankamai teksto.", ["src/module/a.ts"], ["pnpm test"]);

  await persistContextPack({
    fs,
    runtimeRoot,
    taskText: COMPILABLE_TASK,
    encoded: JSON.stringify(pack),
    maxContextChars: 20_000,
    cacheStatus: "bypass",
    droppedItemCount: 0,
    specDroppedCount: 0,
    codeContextDroppedCount: 0,
    codeContextRebuilt: false,
    canaryFeatures: [],
  });

  const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
  const record = JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  assert.equal("dsl_ir_chars" in record, false, "nebevykdomas matavimas yra NESANTIS, ne 0");
  assert.equal("dsl_compiled_chars" in record, false);
  assert.equal(typeof record["raw_prompt_chars"], "number", "žalias prompt'as matuojamas toliau");
});
