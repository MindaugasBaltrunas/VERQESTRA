// Code-index saugyklos schemos (zod prie modulio, kaip `wave-snapshot` ir `task-graph-store`).
//
// 2026-08-23 (operatoriaus radinys): saugykla buvo skaitoma NEVALIDUOJAMAIS type cast'ais
// (`JSON.parse(...) as CodeIndexManifest`, `parseJsonl<CodeIndexEdge>`), o `checkCodeIndexFreshness`
// tikrino tik manifesto egzistavimą, versiją ir `source_hash`. Manifeste užrašyti kiekiai su
// faktiniu turiniu nebuvo lyginami niekada.
//
// Atkurta: ištuštinus `edges.jsonl`, freshness grąžino `ok: true`, o architektūros ribų pažeidimų
// skaičius nukrito nuo 1 iki 0 — vartas tyliai praėjo. Tai fail-open ant varto, o ne vien
// duomenų higienos klausimas: sugadinta saugykla atrodo kaip švarus projektas.
//
// Formatas yra BYTE-COMPAT su etalonu, tad schemos aprašo tik tai, kuo REMIASI skaitytojai;
// nežinomi laukai praleidžiami (`looseObject`), kad būsimas lauko pridėjimas nesugriautų senų
// indeksų — juos ir taip anuliuoja `codeIndexVersion`.
import { z } from "zod";

const nonEmpty = z.string().min(1);

export const codeIndexManifestSchema = z.looseObject({
  version: nonEmpty,
  generated_at: z.string(),
  project_root: z.string(),
  file_count: z.number().int().nonnegative(),
  symbol_count: z.number().int().nonnegative(),
  edge_count: z.number().int().nonnegative(),
  source_hash: nonEmpty,
});

export const codeIndexFileSchema = z.looseObject({
  path: nonEmpty,
  hash: z.string(),
  size: z.number().nonnegative(),
  language: nonEmpty,
  kind: nonEmpty,
  imports: z.array(z.string()),
  exports: z.array(z.string()),
  symbols: z.array(z.string()),
  isTest: z.boolean(),
});

export const codeIndexSymbolSchema = z.looseObject({
  id: nonEmpty,
  file: nonEmpty,
  name: nonEmpty,
  kind: nonEmpty,
  exported: z.boolean(),
});

/**
 * Briaunos schema. `type` privalomas ir netuščias: būtent pagal jį architektūros ribų vartas
 * atrenka `imports` briaunas, tad briauna be tipo yra nematoma briauna.
 */
export const codeIndexEdgeSchema = z.looseObject({
  from: nonEmpty,
  to: nonEmpty,
  type: nonEmpty,
});
