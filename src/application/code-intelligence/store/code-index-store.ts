// Code-index saugykla per portą: keliai, write/read/exists/freshness. Behaviour etalon:
// AG_loop code-index/store.ts; IO — per CodeIntelligenceFileSystemPort (WBR VQ-301),
// baitinė forma — store/format.ts. VERQESTRA runtime šaknis: `vq/state/code-index`.

import path from "node:path";
import { sha256Hex } from "../../../shared/hash.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { computeSourceHash, scanProjectFiles } from "../indexing/scanner.js";
import {
  codeIndexVersion,
  type CodeIndexData,
  type CodeIndexEdge,
  type CodeIndexFile,
  type CodeIndexFreshness,
  type CodeIndexManifest,
  type CodeIndexSymbol,
} from "../indexing/types.js";
import { parseJsonl, renderJsonl, renderManifestJson } from "./format.js";
import {
  codeIndexEdgeSchema,
  codeIndexFileSchema,
  codeIndexManifestSchema,
  codeIndexSymbolSchema,
} from "./code-index-schema.js";

export function codeIndexDir(projectRoot: string): string {
  return path.join(projectRoot, "vq", "state", "code-index");
}

export function codeIndexPath(projectRoot: string, fileName: string): string {
  return path.join(codeIndexDir(projectRoot), fileName);
}

export async function writeCodeIndex(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  data: CodeIndexData,
): Promise<void> {
  await fs.makeDirectory(codeIndexDir(projectRoot));
  await fs.writeTextFileAtomic(codeIndexPath(projectRoot, "files.jsonl"), renderJsonl(data.files));
  await fs.writeTextFileAtomic(codeIndexPath(projectRoot, "symbols.jsonl"), renderJsonl(data.symbols));
  await fs.writeTextFileAtomic(codeIndexPath(projectRoot, "edges.jsonl"), renderJsonl(data.edges));
  await fs.writeTextFileAtomic(codeIndexPath(projectRoot, "manifest.json"), renderManifestJson(data.manifest));
}

/** Manifesto skaitymas atskirai: versijos patikrai įrašų parsinti nereikia. */
async function readCodeIndexManifest(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexManifest> {
  return codeIndexManifestSchema.parse(JSON.parse(await fs.readTextFile(codeIndexPath(projectRoot, "manifest.json"))));
}

export async function readCodeIndex(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexData> {
  // Skaitymas VALIDUOJAMAS, o ne cast'inamas (2026-08-23, operatoriaus radinys). Anksčiau
  // `JSON.parse(...) as CodeIndexManifest` ir `parseJsonl<CodeIndexEdge>` reiškė, kad bet kokia
  // struktūriškai teisinga, bet neteisingo turinio saugykla atrodė kaip galiojantis indeksas.
  const manifest = await readCodeIndexManifest(fs, projectRoot);
  return {
    manifest,
    files: validateRecords(parseJsonl(await fs.readTextFile(codeIndexPath(projectRoot, "files.jsonl"))), codeIndexFileSchema, "files"),
    symbols: validateRecords(
      parseJsonl(await fs.readTextFile(codeIndexPath(projectRoot, "symbols.jsonl"))),
      codeIndexSymbolSchema,
      "symbols",
    ),
    edges: validateRecords(parseJsonl(await fs.readTextFile(codeIndexPath(projectRoot, "edges.jsonl"))), codeIndexEdgeSchema, "edges"),
  };
}

/** Kiekviena eilutė privalo atitikti schemą; pirmoji nepraėjusi įvardijama pagal numerį. */
function validateRecords<T>(records: unknown[], schema: { safeParse: (value: unknown) => { success: boolean } }, label: string): T[] {
  for (const [position, record] of records.entries()) {
    if (!schema.safeParse(record).success) {
      throw new Error(`code index ${label}.jsonl line ${position + 1} does not match the expected shape`);
    }
  }
  return records as T[];
}

export async function codeIndexExists(fs: CodeIntelligenceFileSystemPort, projectRoot: string): Promise<boolean> {
  return await fs.exists(codeIndexPath(projectRoot, "manifest.json"));
}

export async function checkCodeIndexFreshness(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexFreshness> {
  if (!(await codeIndexExists(fs, projectRoot))) {
    return { ok: false, reason: "code index manifest is missing" };
  }

  // Versija tikrinama PIRMA, dar neparsinus įrašų: seno formato indeksas privalo gauti
  // „version mismatch", o ne „unreadable" iš schemos, kuri jam ir neturi galioti.
  let currentManifest: CodeIndexManifest;
  try {
    currentManifest = await readCodeIndexManifest(fs, projectRoot);
  } catch (error) {
    return { ok: false, reason: `code index is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (currentManifest.version !== codeIndexVersion) {
    return {
      ok: false,
      reason: `code index version mismatch: ${currentManifest.version} != ${codeIndexVersion}`,
      manifest: currentManifest,
    };
  }

  let stored: CodeIndexData;
  try {
    stored = await readCodeIndex(fs, projectRoot);
  } catch (error) {
    return { ok: false, reason: `code index is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }

  // VIENTISUMAS prieš šviežumą (2026-08-23, operatoriaus radinys). Manifeste užrašyti kiekiai su
  // faktiniu turiniu nebuvo lyginami niekada, tad ištuštintas `edges.jsonl` praeidavo kaip
  // `ok: true` — o architektūros ribų vartas, skaitantis būtent briaunas, tyliai nustodavo rasti
  // pažeidimus. Sugadinta saugykla atrodydavo kaip švarus projektas.
  //
  // Tikrinama PRIEŠ `source_hash`, nes tai kito lygmens klausimas: šviežumas atsako „ar indeksas
  // atitinka failus", o vientisumas — „ar indeksas apskritai yra tai, kuo sakosi esąs".
  const counts: [string, number, number][] = [
    ["file", currentManifest.file_count, stored.files.length],
    ["symbol", currentManifest.symbol_count, stored.symbols.length],
    ["edge", currentManifest.edge_count, stored.edges.length],
  ];
  const mismatch = counts.find(([, declared, actual]) => declared !== actual);
  if (mismatch) {
    return {
      ok: false,
      reason: `code index is corrupt: manifest declares ${mismatch[1]} ${mismatch[0]} records, storage holds ${mismatch[2]}`,
      manifest: currentManifest,
    };
  }

  // KIEKIŲ NEPAKANKA (2026-08-23 RAG auditas): pakeitus vienos `imports` briaunos taikinį įrašų
  // skaičius nepasikeičia, schema praeina, ir indeksas lieka `fresh: true` — o architektūros
  // pažeidimas dingsta. Kiekis atsako tik „ar nieko nedingo", ne „ar tai tas pats turinys".
  //
  // `records_hash` yra to paties baitinio atvaizdo, kurį saugykla ir rašo, atspaudas, tad jis
  // pagauna BET KOKĮ redagavimą — įskaitant tokį, kuris išlaiko ir kiekius, ir schemą.
  const recordsHash = computeRecordsHash(stored.files, stored.symbols, stored.edges);
  if (recordsHash !== currentManifest.records_hash) {
    return {
      ok: false,
      reason: "code index is corrupt: stored records do not match the fingerprint the manifest declares",
      manifest: currentManifest,
    };
  }

  const files = await scanProjectFiles(fs, projectRoot);
  const sourceHash = await computeSourceHash(files);
  if (sourceHash !== currentManifest.source_hash) {
    return { ok: false, reason: "code index is stale", manifest: currentManifest };
  }

  return { ok: true, manifest: currentManifest };
}

/**
 * Įrašų TURINIO atspaudas: sha256 nuo tų pačių JSONL baitų, kuriuos rašo `writeCodeIndex`.
 *
 * Skaičiuojamas iš baitinio atvaizdo, o ne iš objektų, sąmoningai: taip atspaudas ir saugykla
 * negali išsiskirti — kas užrašyta, tas ir suhash'uota. Kiekiai lieka atskirai, nes jie įvardija
 * gedimą tiksliau („trūksta 3 briaunų"), o atspaudas atsako tik „turinys ne tas".
 */
export function computeRecordsHash(
  files: readonly CodeIndexFile[],
  symbols: readonly CodeIndexSymbol[],
  edges: readonly CodeIndexEdge[],
): string {
  return sha256Hex(`${renderJsonl(files)}${renderJsonl(symbols)}${renderJsonl(edges)}`);
}

export function createManifest(
  projectRoot: string,
  files: CodeIndexFile[],
  symbols: CodeIndexSymbol[],
  edges: CodeIndexEdge[],
  sourceHash: string,
  generatedAt: string = new Date().toISOString(),
): CodeIndexManifest {
  return {
    version: codeIndexVersion,
    generated_at: generatedAt,
    project_root: path.resolve(projectRoot),
    file_count: files.length,
    symbol_count: symbols.length,
    edge_count: edges.length,
    source_hash: sourceHash,
    records_hash: computeRecordsHash(files, symbols, edges),
  };
}
