// Code-index persistencija (etalonas: AG_loop code-index/store.ts). BYTE-COMPAT su
// AG_loop formatu: files/symbols/edges — JSONL (po vieną JSON.stringify eilutę + galinis
// \n), manifest.json — pretty JSON per atominį rašymą. VERQESTRA kelias:
// vq/state/code-index. Freshness skenas — application/code-intelligence scanner per
// createCodeIntelligenceFsAdapter.

import path from "node:path";
import { computeSourceHash, scanProjectFiles } from "../../application/code-intelligence/indexing/scanner.js";
import { createManifest as createCodeIndexManifest } from "../../application/code-intelligence/store/code-index-store.js";
import {
  codeIndexVersion,
  type CodeIndexData,
  type CodeIndexEdge,
  type CodeIndexFile,
  type CodeIndexFreshness,
  type CodeIndexManifest,
  type CodeIndexSymbol,
} from "../../application/code-intelligence/indexing/types.js";
import { toPrettyJson } from "../../shared/json.js";
import { createCodeIntelligenceFsAdapter } from "../fs/code-intelligence-fs-adapter.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export function codeIndexDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "code-index");
}

export function codeIndexPath(runtimeRoot: string, fileName: string): string {
  return path.join(codeIndexDir(runtimeRoot), fileName);
}

export async function writeCodeIndex(runtimeRoot: string, data: CodeIndexData): Promise<void> {
  await nodeFsAdapter.makeDirectory(codeIndexDir(runtimeRoot));
  await writeJsonl(codeIndexPath(runtimeRoot, "files.jsonl"), data.files);
  await writeJsonl(codeIndexPath(runtimeRoot, "symbols.jsonl"), data.symbols);
  await writeJsonl(codeIndexPath(runtimeRoot, "edges.jsonl"), data.edges);
  await nodeFsAdapter.writeTextFile(codeIndexPath(runtimeRoot, "manifest.json"), toPrettyJson(data.manifest));
}

export async function readCodeIndex(runtimeRoot: string): Promise<CodeIndexData> {
  const manifest = JSON.parse(await nodeFsAdapter.readTextFile(codeIndexPath(runtimeRoot, "manifest.json"))) as CodeIndexManifest;
  return {
    manifest,
    files: await readJsonl<CodeIndexFile>(codeIndexPath(runtimeRoot, "files.jsonl")),
    symbols: await readJsonl<CodeIndexSymbol>(codeIndexPath(runtimeRoot, "symbols.jsonl")),
    edges: await readJsonl<CodeIndexEdge>(codeIndexPath(runtimeRoot, "edges.jsonl")),
  };
}

export async function codeIndexExists(runtimeRoot: string): Promise<boolean> {
  return await nodeFsAdapter.exists(codeIndexPath(runtimeRoot, "manifest.json"));
}

export async function checkCodeIndexFreshness(projectRoot: string, runtimeRoot: string): Promise<CodeIndexFreshness> {
  if (!(await codeIndexExists(runtimeRoot))) {
    return { ok: false, reason: "code index manifest is missing" };
  }

  let currentManifest: CodeIndexManifest;
  try {
    currentManifest = (await readCodeIndex(runtimeRoot)).manifest;
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

  const files = await scanProjectFiles(createCodeIntelligenceFsAdapter(projectRoot), projectRoot);
  const sourceHash = await computeSourceHash(files);
  if (sourceHash !== currentManifest.source_hash) {
    return { ok: false, reason: "code index is stale", manifest: currentManifest };
  }

  return { ok: true, manifest: currentManifest };
}

/**
 * Manifestas statomas APPLICATION sluoksnio gamintoju, o ne antra kopija (2026-08-23, RAG
 * auditas 3): jis vienintelis skaičiuoja `records_hash`, ir dvi manifesto formos šaltinio versijos
 * reikštų, kad viena jų anksčiau ar vėliau atsiliks — būtent taip ir nutiko.
 */
export function createManifest(
  projectRoot: string,
  files: CodeIndexFile[],
  symbols: CodeIndexSymbol[],
  edges: CodeIndexEdge[],
  sourceHash: string,
): CodeIndexManifest {
  return createCodeIndexManifest(projectRoot, files, symbols, edges, sourceHash);
}

async function writeJsonl(filePath: string, values: unknown[]): Promise<void> {
  // Atominis rašymas per nodeFsAdapter (unikalus tmp + win32 retry) — etalono task 0064
  // dedup: vietinės atominio rašymo kopijos šiame projekte nebeegzistuoja.
  await nodeFsAdapter.writeTextFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = (await nodeFsAdapter.readTextFileIfExists(filePath)) ?? "";
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
