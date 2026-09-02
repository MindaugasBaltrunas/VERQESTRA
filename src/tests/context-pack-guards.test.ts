// 2026-08-21 RAG audito vartų testai: SRC pjūvių šviežumas ir context-cache rakto kontraktas.
// Atskirai nuo context-pack.test.ts, nes tas jau siekė 500 eilučių ribą, o šie du dalykai
// sudaro savo temą — jie saugo nuo TYLAUS pasenimo, ne nuo neteisingo skaičiavimo.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contextPackSchema } from "../application/context-pack/context-pack-schema.js";
import { CODE_INDEX_UNUSED, CONTEXT_CACHE_VERSION } from "../application/context-pack/context-cache-model.js";
import { contextCacheEntryPath, lookupContextCache } from "../infrastructure/persistence/context-cache-store.js";
import {
  computeContextCacheKey,
  hashText,
  PACK_SEMANTICS_DESCRIPTOR,
} from "../application/context-pack/context-cache-key.js";
import {
  sourceSliceOrigins,
  staleSourceSlicePaths,
  staleSourceSlices,
} from "../application/context-pack/source-slice-freshness.js";
import {
  contextCompressionArrestStatePath,
  contextCompressionConfigPath,
  loadEffectiveCompressionPolicy,
  readContextCompressionArrestState,
} from "../application/context-pack/effective-compression-policy.js";
import { CONTEXT_COMPRESSION_FEATURES } from "../domain/policies/compression/features.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";

// SRC pjūvis yra SNAPSHOT'as. Tarp surinkimo ir dispatch'o failas gali pasikeisti — įprastu,
// ne lenktynių keliu: pirmas bandymas jį suredaguoja, orkestratorius perleidžia tą patį task'ą.
test("source slice freshness: pasikeitęs ir dingęs failas abu yra PASENĘ", async () => {
  const pack = contextPackSchema.parse({
    task_id: "0046-slice",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts", "src/b.ts"],
    checks: ["pnpm test"],
    code_context: {
      enabled: true,
      symbol_fragments: [
        {
          id: "a#x",
          file: "src/a.ts",
          name: "x",
          reason: "exported",
          tier: "SRC",
          source: { line: 1, endLine: 2, hash: "a".repeat(64), text: "senas a" },
        },
        {
          id: "a#y",
          file: "src/a.ts",
          name: "y",
          reason: "exported",
          tier: "SRC",
          source: { line: 5, endLine: 6, hash: "a".repeat(64), text: "senas a2" },
        },
        {
          id: "b#z",
          file: "src/b.ts",
          name: "z",
          reason: "exported",
          tier: "SRC",
          source: { line: 1, endLine: 2, hash: "b".repeat(64), text: "senas b" },
        },
        { id: "c#w", file: "src/c.ts", name: "w", reason: "exported", tier: "SIG", signature: "declare w" },
      ],
    },
  });

  assert.deepEqual(
    sourceSliceOrigins(pack),
    [
      { file: "src/a.ts", hash: "a".repeat(64) },
      { file: "src/b.ts", hash: "b".repeat(64) },
    ],
    "vienas įrašas failui (hash'as yra viso failo), o SIG simbolis snapshot'o neturi",
  );

  const bytes = new Map<string, Uint8Array>([["src/a.ts", new TextEncoder().encode("naujas turinys")]]);
  const stale = await staleSourceSlices(pack, path.resolve("/vq-slice-root"), (file) =>
    Promise.resolve(bytes.get(file)),
  );

  // `src/a.ts` pasikeitė, `src/b.ts` neperskaitomas. Antrasis atvejis svarbus atskirai:
  // NEŽINIA čia negali reikšti šviežumo — vartas tam ir yra.
  assert.deepEqual(stale, ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(
    staleSourceSlicePaths(
      sourceSliceOrigins(pack),
      new Map([
        ["src/a.ts", "a".repeat(64)],
        ["src/b.ts", "b".repeat(64)],
      ]),
    ),
    [],
    "sutampantys hash'ai — vartas praleidžia",
  );
});

// `symbol.file` ateina iš ARTEFAKTO, tad sugadintas ar suklastotas pack'as gali nukreipti
// skaitymą už projekto ribų. Vartas privalo veikti PRIEŠ skaitymą: tikrinama ne tik tai, kad
// verdiktas „pasenęs", bet ir kad skaitytuvas tokiems keliams NEBUVO kviestas.
test("source slice freshness: `../`, absoliutus ir šaknies kelias net neskaitomi (C18)", async () => {
  const root = path.resolve("/vq-slice-escape");
  const escaping = ["../svetimas.ts", "../../etc/passwd", path.join(root, "..", "gretimas.ts")];
  // sha256 tuščių baitų — vidinis failas turi SUTAPTI, kad neužtemdytų rezultato.
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const slice = (index: number, file: string, hash: string) => ({
    id: `s${index}`,
    file,
    name: `n${index}`,
    reason: "exported" as const,
    tier: "SRC" as const,
    source: { line: 1, endLine: 2, hash, text: "x" },
  });

  const pack = contextPackSchema.parse({
    task_id: "0049-escape",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    code_context: {
      enabled: true,
      symbol_fragments: [
        ...escaping.map((file, index) => slice(index, file, "a".repeat(64))),
        slice(9, "src/vidus.ts", emptyHash),
      ],
    },
  });

  const asked: string[] = [];
  const stale = await staleSourceSlices(pack, root, (file) => {
    asked.push(file);
    // Vidinis failas SUTAMPA su užfiksuotu hash'u, tad jis lieka šviežias ir neužtemdo rezultato.
    return Promise.resolve(file === "src/vidus.ts" ? new Uint8Array() : new TextEncoder().encode("kitas"));
  });

  assert.deepEqual(asked, ["src/vidus.ts"], "už ribų vedantys keliai skaitytuvo NEPASIEKIA");
  assert.deepEqual(stale.sort(), [...escaping].sort(), "kiekvienas pabėgimas laikomas pasenusiu");
});

// KONFLIKTUOJANTYS hash'ai: tas pats failas pack'e užfiksuotas su dviem skirtingais hash'ais —
// tai sugadintas pack'as. Anksčiau laimėdavo pirmas, antrasis būdavo IŠMESTAS, tad failui
// sutapus su pirmuoju sugadintas antras pjūvis likdavo nepastebėtas.
test("source slice freshness: konfliktuojantys to paties failo hash'ai yra PASENIMAS", () => {
  const pack = contextPackSchema.parse({
    task_id: "0048-konfliktas",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    code_context: {
      enabled: true,
      symbol_fragments: [
        {
          id: "a#x",
          file: "src/a.ts",
          name: "x",
          reason: "exported",
          tier: "SRC",
          source: { line: 1, endLine: 2, hash: "a".repeat(64), text: "pirmas" },
        },
        {
          id: "a#y",
          file: "src/a.ts",
          name: "y",
          reason: "exported",
          tier: "SRC",
          source: { line: 5, endLine: 6, hash: "c".repeat(64), text: "antras, KITAS hash" },
        },
      ],
    },
  });

  assert.equal(sourceSliceOrigins(pack).length, 2, "abi poros išsaugotos, ne tik pirmoji");

  // Dabartinis failas sutampa su PIRMUOJU hash'u — būtent tas atvejis, kurį senoji versija
  // praleisdavo. Vienas failo hash'as fiziškai negali sutapti su dviem skirtingais.
  assert.deepEqual(
    staleSourceSlicePaths(sourceSliceOrigins(pack), new Map([["src/a.ts", "a".repeat(64)]])),
    ["src/a.ts"],
    "konfliktas yra pasenimas pagal konstrukciją",
  );
});

// PRIMINIMO testas, ne elgsenos testas.
//
// Šaltinių hash'ai mato DUOMENIS, ne kodą: pakeitus pack'o semantiką failams nepasikeitus,
// senas įrašas grįžta kaip `hit` ir tyliai anuliuoja pataisymą. Vienintelė apsauga yra
// `CONTEXT_CACHE_VERSION` kėlimas, o vienintelis būdas apie jį priminti — sulaužyti ką nors
// tam, kas liečia semantiką.
//
// Ką MATO: derinimo konstantų pokyčius — jie eina į raktą per PACK_SEMANTICS_DESCRIPTOR, tad
// senus įrašus invaliduoja PATYS, be versijos kėlimo (deskriptorius hash'uojamas į fingerprint'ą).
// Ko NEMATO: grynai loginių pakeitimų (antraščių sekcijų, ribų varto, kirpimo algoritmo) —
// jie nekeičia nė vienos konstantos. Tokiems versijos kėlimas lieka RANKINIS kontraktas.
//
// Deskriptorius turi dengti KIEKVIENĄ pack'o turinį formuojančią konstantą — 2026-08-24 audite 4
// jame trūko `impacted_test_importer_depth`, 2026-09-01 audite 7 — dar keturių (architektūros
// žymens ilgio, dviejų spec įspėjimų konstantų ir reitingavimo apvalinimo). Nesanti konstanta yra
// spraga pačiame mechanizme, kuris tokias spragas ir turi dengti.
//
// Kai krenta: jei pakeitimas sąmoningas — atnaujink šias eilutes (ir kelk versiją, jei pakeitimas
// buvo loginis, o ne konstantų derinimas).
test("context cache: semantikos deskriptorius prisegtas prie rakto (priminimas kelti versiją)", () => {
  assert.equal(
    CONTEXT_CACHE_VERSION,
    10,
    "pakelta dešimtą kartą: `code_context.symbol_hypothetical_src_chars` (task 089)",
  );
  assert.equal(
    PACK_SEMANTICS_DESCRIPTOR,
    "tiers:direct_spec_reference>heading_match>general_docs" +
      "|change_dir_files:proposal.md,tasks.md,spec.md,design.md" +
      "|max_spec_candidates:64" +
      "|boundary_min_ratio:0.6" +
      "|max_spec_retrieval_warnings:10" +
      "|impacted_test_importer_depth:3" +
      "|min_architecture_token_length:3" +
      "|spec_drop_refs_listed:5" +
      "|warning_severity:imprecise=5,lost=3,missing=2,redundant=4,rejected=0,unreadable=1" +
      "|score_precision:6",
  );

  const key = computeContextCacheKey([
    { kind: "task", path: "AG/tasks/queue/t1.md", hash: "a".repeat(64) },
    { kind: "spec", path: "doc/spec.md", hash: "b".repeat(64) },
  ]);
  assert.match(key.fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(
    key.fingerprint,
    hashText(JSON.stringify({ version: CONTEXT_CACHE_VERSION, components: Object.entries(key.components) })),
    "deskriptorius rakte tikrai dalyvauja, o ne yra dekoracija",
  );
});

// Task 089: kėlimo PRASMĖ, ne tik konstantos reikšmė. Prieš kėlimą sudėtas įrašas neša pack'ą be
// `symbol_hypothetical_src_chars`, ir jo trūkumą skaitytojas laikytų nuliu — būtent tas tylus
// melas ir yra priežastis, dėl kurios versija keliama.
test("context cache: prieš kėlimą sudėtas įrašas (v9) grįžta kaip miss, ne hit", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "vq-cache-version-"));
  try {
    const key = computeContextCacheKey([{ kind: "task", path: "AG/tasks/queue/t1.md", hash: "c".repeat(64) }]);
    const entryPath = contextCacheEntryPath(runtimeRoot, key.fingerprint);
    await mkdir(path.dirname(entryPath), { recursive: true });
    const legacyEntry = {
      version: CONTEXT_CACHE_VERSION - 1,
      task_id: "t1",
      fingerprint: key.fingerprint,
      components: key.components,
      sources: key.sources,
      code_index: CODE_INDEX_UNUSED,
      // Pack'as be naujojo lauko — lygiai toks, kokį gamino v9 surinkimas.
      context_pack_json: '{"code_context":{"enabled":true,"symbol_fragments":[]}}\n',
      selected_chars: 56,
      selected_token_estimate: 14,
    };
    await writeFile(entryPath, `${JSON.stringify(legacyEntry, null, 2)}\n`, "utf8");

    assert.deepEqual(await lookupContextCache(runtimeRoot, key), { status: "miss", reason: "version_mismatch" });
    // Ir jis evict'inamas: kitas lookup'as jau neranda net failo, tad senas pack'as negali
    // sugrįžti nė vienu keliu.
    assert.deepEqual(await lookupContextCache(runtimeRoot, key), { status: "miss", reason: "no_entry" });
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

// Task 128: arrest kill-switch'o skaitymas. Trys atsakymai, kuriuos jis privalo atskirti —
// „markerio nėra" (default), „markeris neperskaitomas" (arrests everything) ir „markeris
// perskaitytas". Iki pataisymo METANTIS skaitymas virsdavo tuščiu stringu, tad kelias per
// `raw === undefined || !raw.trim()` grąžindavo ŠVARŲ default'ą: kompresija liko įjungta, o
// `compression-arrest-observer` unreadable guard'as (jis saugo operatoriaus markerį nuo
// perrašymo) matė „nieko nėra" ir markerį tyliai resetindavo.
function arrestFs(input: {
  configJson?: string;
  arrestJson?: string;
  readFailure?: (absolutePath: string) => Error | undefined;
}): ContextPackFileSystemPort {
  const files = new Map<string, string>();
  return {
    async readTextFileIfExists(absolutePath) {
      const failure = input.readFailure?.(absolutePath);
      if (failure !== undefined) throw failure;
      return files.get(path.resolve(absolutePath));
    },
    async readFileBytes(absolutePath) {
      const value = files.get(path.resolve(absolutePath));
      if (value === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return new TextEncoder().encode(value);
    },
    async exists(absolutePath) {
      return files.has(path.resolve(absolutePath));
    },
    async appendTextFile() {
      // šiems testams log eilutės nesvarbios
    },
    async writeTextFile(absolutePath, content) {
      files.set(path.resolve(absolutePath), content);
    },
    async makeDirectory() {
      // in-memory
    },
  };
}

async function seedArrestFs(input: { configJson?: string; arrestJson?: string; readFailure?: (p: string) => Error | undefined }): Promise<{
  fs: ContextPackFileSystemPort;
  runtimeRoot: string;
}> {
  const runtimeRoot = path.resolve("vq-test-root-arrest-read");
  const fs = arrestFs(input);
  if (input.configJson !== undefined) {
    await fs.writeTextFile(contextCompressionConfigPath(runtimeRoot), input.configJson);
  }
  if (input.arrestJson !== undefined) {
    await fs.writeTextFile(contextCompressionArrestStatePath(runtimeRoot), input.arrestJson);
  }
  return { fs, runtimeRoot };
}

const ALL_FEATURES_ON = JSON.stringify({
  version: 1,
  features: {
    worker_task_ir: true,
    compact_dsl: true,
    symbol_slices: true,
    bash_output_digest: true,
    dispatch_tool_schema: true,
  },
});

test("arrest marker: METANTIS skaitymas yra `unreadable`, ne švarus default", async () => {
  const arrestPath = contextCompressionArrestStatePath(path.resolve("vq-test-root-arrest-read"));
  const { fs, runtimeRoot } = await seedArrestFs({
    configJson: ALL_FEATURES_ON,
    arrestJson: JSON.stringify({ version: 1, arrests: [] }),
    readFailure: (absolutePath) =>
      path.resolve(absolutePath) === path.resolve(arrestPath) ? new Error("EACCES: permission denied") : undefined,
  });

  const view = await readContextCompressionArrestState(fs, runtimeRoot);
  assert.equal(view.unreadable, true, "nežinia apie kill-switch'ą negali skambėti kaip „areštų nėra“");
  assert.match(view.unreadableReason ?? "", /EACCES/, "priežastis cituoja tikrą skaitymo klaidą");

  // Fail-closed kryptis: neperskaitomas marker'is areštuoja VISKĄ, nors konfigas visas įjungtas.
  const policy = await loadEffectiveCompressionPolicy({
    fs,
    clock: { timestamp: () => "2026-09-02T00:00:00.000Z" },
    runtimeRoot,
  });
  for (const feature of CONTEXT_COMPRESSION_FEATURES) {
    assert.equal(policy.config.features[feature], false, `${feature} privalo būti išjungta`);
  }
});

test("arrest marker: nesamas ir tuščias failas lieka default (unreadable=false)", async () => {
  const absent = await seedArrestFs({ configJson: ALL_FEATURES_ON });
  const absentView = await readContextCompressionArrestState(absent.fs, absent.runtimeRoot);
  assert.equal(absentView.unreadable, false, "failo nebuvimas yra atsakymas, ne klaida");
  assert.deepEqual(absentView.state.arrests, []);
  const absentPolicy = await loadEffectiveCompressionPolicy({
    fs: absent.fs,
    clock: { timestamp: () => "2026-09-02T00:00:00.000Z" },
    runtimeRoot: absent.runtimeRoot,
  });
  assert.equal(absentPolicy.config.features.worker_task_ir, true, "be arešto autorinis konfigas galioja");

  const empty = await seedArrestFs({ configJson: ALL_FEATURES_ON, arrestJson: "   \n" });
  const emptyView = await readContextCompressionArrestState(empty.fs, empty.runtimeRoot);
  assert.equal(emptyView.unreadable, false, "tuščias marker'is yra ta pati „areštų nėra“ būsena");
  assert.deepEqual(emptyView.state.arrests, []);
});

test("arrest marker: sugadintas JSON lieka `unreadable`", async () => {
  const { fs, runtimeRoot } = await seedArrestFs({ configJson: ALL_FEATURES_ON, arrestJson: "{ ne json" });
  const view = await readContextCompressionArrestState(fs, runtimeRoot);
  assert.equal(view.unreadable, true);
});
