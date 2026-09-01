// Mermaid classDiagram code-map generavimas iš AST skenavimo. Behaviour etalon: AG_loop
// architecture/code-map-generator.ts; rašymas — per portą, output kelias — VERQESTRA
// architektūros artefaktų katalogas.

import path from "node:path";
import { toPosixPath } from "../../../shared/paths.js";
import { sha256Hex } from "../../../shared/hash.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import type { ImportEdge, ScannedFile, SymbolRecord } from "./index-projection.js";

export const GENERATED_CODE_MAP_RELATIVE_PATH = "vq/architecture/generated/code-map.generated.mmd";

const GENERATED_HEADER = [
  "%% code-map.generated.mmd",
  "%% AST-backed full code-map, generated from SymbolRecord[]/ImportEdge[]",
  "%% (application/code-intelligence/code-map/index-projection.ts). Do not hand-edit;",
  "%% regenerate via the code-map generator (application/code-intelligence/code-map/generator.ts).",
].join("\n");

/**
 * Deterministinis Mermaid `classDiagram` klasės ID failo keliui.
 *
 * INJEKTYVUS nuo 2026-08-23 (operatoriaus radinys). Iki tol ID buvo tik „nesaugius simbolius keisk
 * pabraukimu", ir tai suliedavo nesusijusius failus į VIENĄ diagramos mazgą:
 *
 *   src/a-b.ts  src/a_b.ts  src/a.b.ts  src/a/b.ts  src/a b.ts   →  visi `src_a_b`
 *   src/Ą-b.ts                                                    →  `src_b`
 *
 *   Ketvirtasis yra sunkiausias: tai KITAS katalogas, tad diagrama rodydavo neteisingą struktūrą,
 *   o ne tik neteisingą vardą.
 *
 * Skaitomas prefiksas paliekamas, o tapatybę užtikrina kelio hash'as. Skaitomumo kaina nulinė:
 * ID yra vidinis, o matomas žymuo yra PILNAS kelias (`class <id>["src/a-b.ts"]`).
 */
export function classIdForFile(filePath: string): string {
  const posix = toPosixPath(filePath);
  const withoutExtension = posix.replace(/\.(tsx?|jsx?|[mc][tj]s)$/, "");
  const sanitized = withoutExtension.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${sanitized.length > 0 ? sanitized : "f"}_${sha256Hex(posix).slice(0, 8)}`;
}

export function memberLineForSymbol(record: SymbolRecord): string {
  switch (record.kind) {
    case "class":
      return `    +class ${record.name}`;
    case "interface":
      return `    +interface ${record.name}`;
    case "enum":
      return `    +enum ${record.name}`;
    case "typeAlias":
      return `    +type ${record.name}`;
    case "const":
      return `    +${record.name}`;
    case "function":
    case "method":
      return `    +${record.name}()`;
  }
}

type FileBlock = {
  filePath: string;
  layer: string;
  records: SymbolRecord[];
};

/**
 * Failų blokai. Pradedama nuo NUSKENUOTŲ failų, o ne nuo simbolių (2026-08-23, RAG auditas 3):
 * failas be eksportuotų deklaracijų (pvz. vien šalutinius efektus vykdantis bootstrap'as ar
 * re-eksportų barrel'is) diagramoje neturėdavo mazgo, tad ir importai į jį dingdavo be pėdsako.
 * Toks failas dabar gauna tuščią bloką — matomą, bet be narių.
 */
function groupSymbolsByFile(symbols: SymbolRecord[], files: ScannedFile[]): FileBlock[] {
  const byFile = new Map<string, FileBlock>();
  for (const file of files) {
    byFile.set(file.filePath, { filePath: file.filePath, layer: file.layer, records: [] });
  }
  for (const record of symbols) {
    const existing = byFile.get(record.filePath);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    byFile.set(record.filePath, { filePath: record.filePath, layer: record.layer, records: [record] });
  }
  return [...byFile.values()].sort(
    (left, right) => left.layer.localeCompare(right.layer) || left.filePath.localeCompare(right.filePath),
  );
}

function groupFilesByLayer(files: FileBlock[]): Map<string, FileBlock[]> {
  const byLayer = new Map<string, FileBlock[]>();
  for (const file of files) {
    const bucket = byLayer.get(file.layer);
    if (bucket) {
      bucket.push(file);
      continue;
    }
    byLayer.set(file.layer, [file]);
  }
  return byLayer;
}

function renderFileBlock(file: FileBlock): string[] {
  const classId = classIdForFile(file.filePath);
  const lines = [`    class ${classId}["${file.filePath}"] {`, `      <<${file.layer}>>`];
  for (const record of file.records) {
    lines.push(memberLineForSymbol(record));
  }
  lines.push("    }");
  return lines;
}

/** Viena laukiama diagramos briauna: renderio raktas plius skaitomi galai aprėpties ataskaitai. */
export type ExpectedImportEdge = {
  /** `fromId-->toId` — tiksliai tai, ką renderis paverčia `A --> B` eilute. */
  key: string;
  fromFile: string;
  toTarget: string;
};

/**
 * Laukiamų briaunų aibė — VIENAS tiesos šaltinis renderiui ir aprėpčiai (2026-09-01).
 *
 * Rezoliucijos čia NEBĖRA (2026-08-24): `ImportEdge.toTarget` jau yra indekso išspręstas kelias,
 * tad lieka tik atrinkti tuos, kurie rodo į diagramoje esantį failą. Ankstesnis vietinis rezolverius
 * mokėjo tik reliatyvius kelius, tad kiekvienas alias ar path-mapped importas iš diagramos dingdavo
 * — nors indeksas jį jau turėjo išsprendęs per tikrą tsconfig rezoliuciją.
 *
 * Funkcija eksportuota todėl, kad aprėptis privalo laukiamas briaunas išvesti TA PAČIA logika, o ne
 * savo kopija: kopija išsiskirtų tyliai, o tyli spraga aprėptyje yra būtent tai, ką ji turi gaudyti.
 */
export function expectedImportEdges(
  imports: readonly ImportEdge[],
  knownFiles: ReadonlySet<string>,
): ExpectedImportEdge[] {
  const seen = new Set<string>();
  const edges: ExpectedImportEdge[] = [];
  for (const edge of imports) {
    const target = edge.toTarget;
    if (!knownFiles.has(target) || target === edge.fromFile) continue;
    const key = `${classIdForFile(edge.fromFile)}-->${classIdForFile(target)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ key, fromFile: edge.fromFile, toTarget: target });
  }
  // Kodo taškų palyginimas, ne `localeCompare`: generuojamo `.mmd` eilių tvarka negali priklausyti
  // nuo mašinos lokalės.
  edges.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return edges;
}

/** Briaunos tarp diagramos mazgų — renderis virš {@link expectedImportEdges}. */
function renderImportEdges(imports: ImportEdge[], knownFiles: ReadonlySet<string>): string[] {
  return expectedImportEdges(imports, knownFiles).map((edge) => `  ${edge.key.replace("-->", " --> ")}`);
}

/** Pure Mermaid `classDiagram` generation from AST-scanned symbols/imports; no filesystem access. */
export function generateCodeMapMermaid(symbols: SymbolRecord[], imports: ImportEdge[], scanned: ScannedFile[] = []): string {
  const files = groupSymbolsByFile(symbols, scanned);
  const knownFiles = new Set(files.map((file) => file.filePath));
  const byLayer = groupFilesByLayer(files);
  const layers = [...byLayer.keys()].sort();

  const sections: string[] = [];
  for (const layer of layers) {
    sections.push(`  %% --- layer: ${layer} ---`);
    for (const file of byLayer.get(layer) ?? []) {
      sections.push(...renderFileBlock(file).map((line) => `  ${line}`));
    }
  }

  const edgeLines = renderImportEdges(imports, knownFiles);

  return [
    GENERATED_HEADER,
    "",
    "classDiagram",
    "  direction LR",
    "",
    ...sections,
    ...(edgeLines.length > 0 ? ["", ...edgeLines] : []),
    "",
  ].join("\n");
}

/** Generates the Mermaid code-map and writes it to {@link GENERATED_CODE_MAP_RELATIVE_PATH}. */
export async function writeGeneratedCodeMap(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  symbols: SymbolRecord[],
  imports: ImportEdge[],
  scanned: ScannedFile[] = [],
): Promise<string> {
  const mermaid = generateCodeMapMermaid(symbols, imports, scanned);
  const outputPath = path.join(projectRoot, ...GENERATED_CODE_MAP_RELATIVE_PATH.split("/"));
  await fs.makeDirectory(path.dirname(outputPath));
  await fs.writeTextFileAtomic(outputPath, mermaid);
  return outputPath;
}
