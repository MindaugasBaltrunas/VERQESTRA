// VQ-003f characterization (PAR-1): PILNAS `assembleContextPack` kelias per tmpdir workspace —
// baseline, heading-miss, budget-shrink, code-graph ir kešo hit idempotencija.
//
// Kuo šis runner'is skiriasi nuo kitų VQ-003x: etalono pusėje fixture failo NĖRA (etalonas
// read-only, žr. CLAUDE.md), tad `etalon` reikšmes užrašė `scripts/record-context-pack-assembly.mjs`,
// paleidęs AG_loop `dist` prieš TUOS PAČIUS workspace failus. VERQESTRA šiame kelyje turi
// sąmoningų nukrypimų (2026-08-21 RAG auditas), tad fixture neša ir NUKRYPIMŲ REGISTRĄ: runner'is
// uždeda deklaruotus nukrypimus ant etalono projekcijos ir tik tada lygina. Iš to plaukia du
// vartai vienu metu — nedeklaruotas skirtumas krenta kaip regresija, o pasenęs (nebeaktyvus)
// registro įrašas krenta kaip melagingas dokumentas. Record režimo čia NĖRA.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleContextPack } from "../application/context-pack/assemble/assemble.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { createContextCacheAdapter } from "../infrastructure/persistence/context-cache-store.js";
import { nodeContextPackFsPort, nodeFsTestPort } from "./helpers/node-fs-port.js";

type RunProjection = {
  output_path: string;
  execution_context_path: string;
  pack_chars: number;
  pack_key_order: string[];
  pack: Record<string, unknown>;
  metrics: Record<string, unknown>;
};

type Deviation = {
  path: string;
  op: "set" | "add" | "remove";
  value?: unknown;
  deviations: string[];
  reason: string;
};

type AssemblyCase = {
  id: string;
  description: string;
  args: string[];
  prebuild_index: boolean;
  files: Record<string, string>;
  etalon: RunProjection[];
  deviations: Deviation[];
};

type AssemblyFixture = {
  schema_version: number;
  record?: boolean;
  deviation_catalog: Record<string, string>;
  workspace: { files: Record<string, string> };
  cases: AssemblyCase[];
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "context-pack-assembly.json",
);

const fixture: AssemblyFixture = JSON.parse(await readFile(fixturePath, "utf8"));

// VERQESTRA runtime šaknis. `AG/tasks/**` lieka `AG/` abiejose pusėse (eilės kontraktas),
// tad keičiamas tik `{runtime}` žymeklis.
const RUNTIME = "vq";

const METRIC_KEYS = [
  "task_id",
  "cache_status",
  "dropped_item_count",
  "spec_dropped_count",
  "code_context_dropped_count",
  "code_context_rebuilt",
] as const;

const toPosix = (value: string): string => value.split(path.sep).join("/");

/** Runtime šaknies žymeklis atgal į duomenis: `vq/logs/...` → `{runtime}/logs/...`. */
function neutralize(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(`${RUNTIME}/`, "{runtime}/");
  if (Array.isArray(value)) return value.map(neutralize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutralize(item)]));
  }
  return value;
}

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

async function projectRun(root: string, outputPath: string, executionContextPath: string): Promise<RunProjection> {
  const encoded = await readFile(outputPath, "utf8");
  const metricsRaw = await readFile(path.join(root, RUNTIME, "logs", "context-size.jsonl"), "utf8").catch(() => "");
  const lines = metricsRaw.trim().split("\n").filter(Boolean);
  const last = lines.at(-1);
  const record = asRecord(last === undefined ? {} : JSON.parse(last));
  const metrics: Record<string, unknown> = {};
  for (const key of METRIC_KEYS) if (key in record) metrics[key] = record[key];
  return {
    output_path: neutralize(toPosix(path.relative(root, outputPath))) as string,
    execution_context_path: neutralize(toPosix(path.relative(root, executionContextPath))) as string,
    pack_chars: encoded.length,
    pack_key_order: Object.keys(asRecord(JSON.parse(encoded))),
    pack: neutralize(JSON.parse(encoded)) as Record<string, unknown>,
    metrics: neutralize(metrics) as Record<string, unknown>,
  };
}

/**
 * Nukrypimo kelias yra `"<paleidimo indeksas>.<laukas>[.<laukas>...]"`. Grąžinamas paskutinio
 * segmento TĖVAS ir pats segmentas — kad `add`/`remove` galėtų kalbėti apie rakto BUVIMĄ, o ne
 * tik apie reikšmę: tuo skiriasi „lauko nėra" nuo „laukas yra ir lygus `undefined`".
 */
function resolveParent(runs: RunProjection[], deviationPath: string): { parent: Record<string, unknown>; key: string } {
  const segments = deviationPath.split(".");
  const runSegment = segments[0];
  const key = segments.at(-1);
  assert.ok(runSegment !== undefined && key !== undefined, `tuščias nukrypimo kelias: ${deviationPath}`);
  const runIndex = Number(runSegment);
  const run = runs[runIndex];
  assert.ok(run !== undefined, `nukrypimas rodo į neegzistuojantį paleidimą: ${deviationPath}`);
  let parent: Record<string, unknown> = asRecord(run);
  for (const segment of segments.slice(1, -1)) {
    const next = parent[segment];
    assert.ok(
      next !== null && typeof next === "object",
      `nukrypimo kelias nutrūksta ties "${segment}": ${deviationPath}`,
    );
    parent = asRecord(next);
  }
  return { parent, key };
}

/**
 * Uždeda deklaruotus nukrypimus ant etalono projekcijos IR patikrina, kad kiekvienas jų vis dar
 * yra tikras skirtumas. Nebeaktyvus įrašas (etalonas jau sutampa) yra klaida, o ne triukšmas:
 * registras, kuris vardija nebeegzistuojantį nukrypimą, meluoja apie sistemą taip pat, kaip
 * tylus nukrypimas.
 */
function expectationFor(assemblyCase: AssemblyCase): RunProjection[] {
  const expected = structuredClone(assemblyCase.etalon);
  for (const deviation of assemblyCase.deviations) {
    for (const id of deviation.deviations) {
      assert.ok(
        Object.hasOwn(fixture.deviation_catalog, id),
        `${assemblyCase.id}: nukrypimas "${id}" nėra deviation_catalog sąraše`,
      );
    }
    assert.ok(deviation.reason.trim().length > 0, `${assemblyCase.id}: nukrypimas be pagrindimo (${deviation.path})`);
    const { parent, key } = resolveParent(expected, deviation.path);
    const present = Object.hasOwn(parent, key);
    if (deviation.op === "add") {
      assert.equal(present, false, `${assemblyCase.id}: "${deviation.path}" etalone JAU yra — nukrypimas pasenęs`);
      parent[key] = deviation.value;
      continue;
    }
    if (deviation.op === "remove") {
      assert.equal(present, true, `${assemblyCase.id}: "${deviation.path}" etalone NĖRA — nukrypimas pasenęs`);
      delete parent[key];
      continue;
    }
    assert.equal(present, true, `${assemblyCase.id}: "${deviation.path}" etalone nėra — set neturi ką pakeisti`);
    assert.notDeepEqual(
      parent[key],
      deviation.value,
      `${assemblyCase.id}: "${deviation.path}" jau sutampa su etalonu — nukrypimas pasenęs`,
    );
    parent[key] = deviation.value;
  }
  return expected;
}

async function materialize(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative.replaceAll("{runtime}", RUNTIME));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
}

async function runCase(assemblyCase: AssemblyCase): Promise<RunProjection[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), `vq-003f-${assemblyCase.id}-`));
  try {
    await materialize(root, { ...fixture.workspace.files, ...assemblyCase.files });
    if (assemblyCase.prebuild_index) await buildCodeIndex(nodeFsTestPort, root);
    const deps = {
      fs: nodeContextPackFsPort,
      codeFs: nodeFsTestPort,
      // Kešas yra šio kelio dalis, ne priedas: `cache-hit` atvejis be jo neturėtų ką matuoti,
      // o be porto `assembleContextPack` elgtųsi kaip `--no-context-cache` (bypass).
      cache: createContextCacheAdapter(root, path.join(root, RUNTIME)),
    };
    const runs: RunProjection[] = [];
    for (let index = 0; index < assemblyCase.etalon.length; index += 1) {
      const result = await assembleContextPack(assemblyCase.args, root, deps);
      runs.push(await projectRun(root, result.outputPath, result.executionContextPath));
    }
    return runs;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

assert.equal(fixture.record ?? false, false, "VERQESTRA runner'is record režimo neturi (PAR-1)");
assert.ok(fixture.cases.length > 0, "fixture be atvejų");

for (const assemblyCase of fixture.cases) {
  test(`assembleContextPack characterization: ${assemblyCase.id}`, async () => {
    const actual = await runCase(assemblyCase);
    assert.deepEqual(actual, expectationFor(assemblyCase), assemblyCase.description);
  });
}

// Kešo idempotencija turi savo teiginį, nors ją dengia ir projekcijų palyginimas: ten ji būtų
// tik dviejų vienodų blokų sutapimas, o čia — įvardytas kontraktas. `hit` privalo grąžinti TĄ
// PATĮ pack'ą, o ne „tokį pat gerą": jei jis skirtųsi, kešas nebūtų kešas.
test("assembleContextPack characterization: hit grąžina byte-identišką pack'ą", async () => {
  const repeated = fixture.cases.filter((entry) => entry.etalon.length > 1);
  assert.ok(repeated.length > 0, "fixture privalo turėti bent vieną kartotinį atvejį");
  for (const assemblyCase of repeated) {
    const runs = await runCase(assemblyCase);
    const first = runs[0];
    assert.ok(first !== undefined);
    for (const [index, run] of runs.entries()) {
      if (index === 0) continue;
      assert.deepEqual(run.pack, first.pack, `${assemblyCase.id}: ${index + 1}-as pack'as skiriasi`);
      assert.deepEqual(run.pack_key_order, first.pack_key_order, `${assemblyCase.id}: raktų tvarka skiriasi`);
      assert.equal(run.pack_chars, first.pack_chars, `${assemblyCase.id}: pack'o dydis skiriasi`);
      assert.equal(run.metrics["cache_status"], "hit", `${assemblyCase.id}: pakartotinis surinkimas nėra hit`);
    }
    assert.equal(first.metrics["cache_status"], "miss", `${assemblyCase.id}: pirmas surinkimas nėra miss`);
  }
});
