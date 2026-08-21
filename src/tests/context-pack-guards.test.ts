// 2026-08-21 RAG audito vartų testai: SRC pjūvių šviežumas ir context-cache rakto kontraktas.
// Atskirai nuo context-pack.test.ts, nes tas jau siekė 500 eilučių ribą, o šie du dalykai
// sudaro savo temą — jie saugo nuo TYLAUS pasenimo, ne nuo neteisingo skaičiavimo.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { contextPackSchema } from "../application/context-pack/context-pack-schema.js";
import { CONTEXT_CACHE_VERSION } from "../application/context-pack/context-cache-model.js";
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
// Ką MATO: derinimo konstantų pokyčius — jie eina į raktą per PACK_SEMANTICS_DESCRIPTOR.
// Ko NEMATO: grynai loginių pakeitimų (antraščių sekcijų, ribų varto, kirpimo algoritmo) —
// jie nekeičia nė vienos konstantos. Tokiems versijos kėlimas lieka RANKINIS kontraktas.
//
// Kai krenta: jei pakeitimas sąmoningas — kelk versiją IR atnaujink šias eilutes.
test("context cache: semantikos deskriptorius prisegtas prie rakto (priminimas kelti versiją)", () => {
  assert.equal(CONTEXT_CACHE_VERSION, 3, "pakelta antrą kartą: allowed_paths, #anchor ir metrikos");
  assert.equal(
    PACK_SEMANTICS_DESCRIPTOR,
    "tiers:direct_spec_reference>heading_match>general_docs" +
      "|change_dir_files:proposal.md,tasks.md,spec.md,design.md" +
      "|max_spec_candidates:64" +
      "|boundary_min_ratio:0.6" +
      "|max_spec_retrieval_warnings:10",
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
