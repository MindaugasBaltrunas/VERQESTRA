// Pilnas code-index build'as: scan → AST index → test briaunos → dedup → manifest → store.
// Behaviour etalon: AG_loop code-index/builder.ts; FS — per portą (WBR VQ-301).

import path from "node:path";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { createManifest, writeCodeIndex } from "../store/code-index-store.js";
import { computeSourceHash, scanProjectFiles } from "./scanner.js";
import { indexTypeScriptFiles } from "./ts-indexer.js";
import { hasLexicalIndexer, indexLexicalSource, parseComposerPsr4, type LexicalIndexContext } from "./language-indexer.js";
import type { LanguageIndexResult } from "./language-indexer-model.js";
import type { CodeIndexData, CodeIndexEdge, CodeIndexFile, CodeIndexLanguage, CodeIndexSymbol } from "./types.js";

/** Kalbos, kurių failai yra ŠALTINIS testų briaunoms — t. y. visos, kurioms turime ištraukėją. */
const INDEXED_SOURCE_LANGUAGES = new Set<CodeIndexLanguage>(["typescript", "javascript", "python", "php", "csharp", "dotnet"]);

export async function buildCodeIndex(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexData> {
  const scanned = await scanProjectFiles(fs, projectRoot);
  const files: CodeIndexFile[] = [];
  const symbols: CodeIndexSymbol[] = [];
  const edges: CodeIndexEdge[] = [];

  // One batch call (design §2): tsconfig discovery, config parsing and the module
  // resolution cache are built once per build, not once per file. Apima ir JavaScript'ą.
  const indexed = await indexTypeScriptFiles(fs, projectRoot, scanned);

  // Leksinės kalbos (Python, PHP, C#, .NET projektai) — po failą, bet jų kontekstas
  // (`knownPaths`, PSR-4) paruošiamas VIENĄ kartą: per failą jis būtų N kartų tas pats.
  const context: LexicalIndexContext = {
    knownPaths: new Set(scanned.map((file) => file.path)),
    psr4: parseComposerPsr4(await readOptionalConfig(fs, path.join(projectRoot, "composer.json"))),
    pythonRoots: await discoverPythonRoots(fs, projectRoot, scanned),
  };

  for (const file of scanned) {
    const result = indexed.get(file.path) ?? (await indexLexical(fs, projectRoot, file, context));
    if (!result) {
      files.push(file);
      continue;
    }
    files.push(result.file);
    symbols.push(...result.symbols);
    edges.push(...result.edges);
  }

  edges.push(...deriveTestEdges(files));
  const unique = uniqueEdges(edges);
  const sourceHash = await computeSourceHash(scanned);
  // Rūšiuojama PRIEŠ manifestą: `records_hash` skaičiuojamas nuo tų pačių baitų, kurie bus
  // užrašyti, tad manifesto gamyba privalo matyti galutinę įrašų tvarką.
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const sortedSymbols = [...symbols].sort((left, right) => left.id.localeCompare(right.id));
  const data: CodeIndexData = {
    manifest: createManifest(projectRoot, sortedFiles, sortedSymbols, unique, sourceHash),
    files: sortedFiles,
    symbols: sortedSymbols,
    edges: unique,
  };
  await writeCodeIndex(fs, projectRoot, data);
  return data;
}

/**
 * NEPRIVALOMAS konfigo failas: jo nebuvimas nėra klaida (`composer.json` daugumoje projektų
 * paprasčiausiai nėra).
 *
 * Ši tolerancija galioja TIK konfigui. Iki 2026-08-23 ta pati funkcija buvo naudojama ir ŠALTINIO
 * failams, tad bet kokia skaitymo klaida virsdavo `undefined`, o failas likdavo indekse be importų
 * ir simbolių — be jokios degradacijos žymos. Tuo pačiu metu TypeScript kelias tokiu atveju META.
 * Dvi to paties gedimo elgsenos viename indekse reiškia, kad pusė jo gali būti tyliai tuščia.
 */
async function readOptionalConfig(fs: CodeIntelligenceFileSystemPort, absolute: string): Promise<string | undefined> {
  try {
    return await fs.readTextFile(absolute);
  } catch {
    return undefined;
  }
}

async function indexLexical(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  file: CodeIndexFile,
  context: LexicalIndexContext,
): Promise<LanguageIndexResult | undefined> {
  if (!hasLexicalIndexer(file)) return undefined;
  // Skaitymo klaida PROPAGUOJAMA — lygiai kaip TypeScript kelyje. Failas, kurį ką tik nuskenavome,
  // bet nebegalime perskaityti, reiškia arba lenktynę, arba teisių problemą; abiem atvejais
  // pusiau tuščias indeksas, atrodantis pilnas, yra blogiau nei garsi klaida.
  const text = await fs.readTextFile(path.join(projectRoot, file.path));
  return indexLexicalSource(file, text, context);
}

function deriveTestEdges(files: CodeIndexFile[]): CodeIndexEdge[] {
  // Testų briaunos anksčiau buvo tik TypeScript'ui (2026-08-23): dabar jas gauna kiekviena kalba,
  // kuri turi importus — kitaip `pytest` ar `xUnit` failas indekse liktų nesusietas su tuo, ką tikrina.
  const sourceFiles = files.filter((file) => !file.isTest && INDEXED_SOURCE_LANGUAGES.has(file.language));
  const testFiles = files.filter((file) => file.isTest);
  const edges: CodeIndexEdge[] = [];
  for (const testFile of testFiles) {
    for (const imported of testFile.imports) {
      if (sourceFiles.some((sourceFile) => sourceFile.path === imported)) {
        edges.push({ from: imported, to: testFile.path, type: "testedBy" });
      }
    }

    const normalizedTest = testFile.path.toLowerCase();
    for (const sourceFile of sourceFiles) {
      const sourceBase = sourceFile.path.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() ?? "";
      if (sourceBase && normalizedTest.includes(sourceBase)) {
        edges.push({ from: sourceFile.path, to: testFile.path, type: "testedBy", detail: "name-match" });
      }
    }
  }
  return edges;
}

function uniqueEdges(edges: CodeIndexEdge[]): CodeIndexEdge[] {
  const byKey = new Map<string, CodeIndexEdge>();
  for (const edge of edges) {
    byKey.set([edge.type, edge.from, edge.to, edge.detail ?? ""].join("|"), edge);
  }
  // `detail` is part of the sort key (design §2): reExports edges can differ only in
  // detail, and relying on sort stability + Map insertion order would make edge order
  // depend on collection order instead of content.
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.type}:${left.from}:${left.to}:${left.detail ?? ""}`.localeCompare(
      `${right.type}:${right.from}:${right.to}:${right.detail ?? ""}`,
    ),
  );
}
