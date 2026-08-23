// .NET projektų failų ištraukėjas: `.csproj`, `.sln`, `.props`, `.targets`.
//
// Čia „importas" reiškia projekto priklausomybę, ne kalbos `using`. Tai KITAS grafas nei C# tipų
// grafas, ir jis yra vertingesnis architektūros riboms: būtent `ProjectReference` pasako, kuris
// sluoksnis kurį mato.
//
// Palaikomos abi projektų formos — SDK-style (`<Project Sdk="…">`) ir senoji `.csproj`, — nes
// reikalavimas yra „visi framework'ai", o legacy projektai gyvi ASP.NET Framework kodo bazėse.
// Skiriama:
//   `ProjectReference`, `Import Project`, `.sln` įrašai → repo keliai (tikros briaunos);
//   `PackageReference`, `Reference`                     → NuGet/GAC vardai (išorė).

import { blankOutNoise, lineAt, lineIndex, XML_QUOTES } from "./lexical.js";
import type { CodeIndexFile, CodeIndexSymbol } from "./types.js";
import type { LanguageIndexResult } from "./language-indexer-model.js";

const PROJECT_REFERENCE = /<ProjectReference[^>]*\sInclude\s*=\s*"([^"]+)"/gi;
const XML_IMPORT = /<Import[^>]*\sProject\s*=\s*"([^"]+)"/gi;
const PACKAGE_REFERENCE = /<PackageReference[^>]*\sInclude\s*=\s*"([^"]+)"/gi;
const ASSEMBLY_REFERENCE = /<Reference[^>]*\sInclude\s*=\s*"([^",]+)/gi;
const SDK_ATTRIBUTE = /<Project[^>]*\sSdk\s*=\s*"([^"]+)"/i;
const TARGET_NAME = /<Target[^>]*\sName\s*=\s*"([^"]+)"/gi;
const ASSEMBLY_NAME = /<AssemblyName>([^<]+)<\/AssemblyName>/i;
const SLN_PROJECT = /^Project\("\{[^}]*\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm;

export function indexDotnetProject(file: CodeIndexFile, text: string, knownPaths: ReadonlySet<string>): LanguageIndexResult {
  return file.path.toLowerCase().endsWith(".sln")
    ? indexSolution(file, text, knownPaths)
    : indexProjectFile(file, text, knownPaths);
}

function indexProjectFile(file: CodeIndexFile, text: string, knownPaths: ReadonlySet<string>): LanguageIndexResult {
  // XML komentaruose `<ProjectReference>` pasitaiko dažnai (išjungtos priklausomybės) — jie
  // ištrinami, kad išjungta nuoroda netaptų briauna.
  const clean = blankOutNoise(text, "xml", XML_QUOTES);
  const offsets = lineIndex(clean);
  const imports = new Set<string>();

  for (const pattern of [PROJECT_REFERENCE, XML_IMPORT]) {
    for (const match of clean.matchAll(pattern)) {
      const raw = match[1] ?? "";
      if (!raw || raw.includes("$(")) continue; // MSBuild savybė — kelio be konteksto nežinome.
      imports.add(resolveRelativePath(file.path, raw, knownPaths) ?? normalizeSeparators(raw));
    }
  }
  for (const pattern of [PACKAGE_REFERENCE, ASSEMBLY_REFERENCE]) {
    for (const match of clean.matchAll(pattern)) {
      const name = (match[1] ?? "").trim();
      if (name) imports.add(name);
    }
  }

  const sdk = SDK_ATTRIBUTE.exec(clean)?.[1];
  if (sdk) imports.add(sdk);

  const symbols: CodeIndexSymbol[] = [];
  const assembly = ASSEMBLY_NAME.exec(clean)?.[1]?.trim() ?? baseName(file.path);
  symbols.push({
    id: `${file.path}#${assembly}`,
    file: file.path,
    name: assembly,
    kind: "const",
    exported: true,
    line: 1,
    endLine: lineAt(offsets, clean.length),
  });

  for (const match of clean.matchAll(TARGET_NAME)) {
    const name = match[1] ?? "";
    if (!name) continue;
    const start = match.index ?? 0;
    symbols.push({
      id: `${file.path}#${name}`,
      file: file.path,
      name,
      kind: "function",
      exported: true,
      line: lineAt(offsets, start),
      endLine: lineAt(offsets, start),
    });
  }

  return finish(file, imports, symbols);
}

function indexSolution(file: CodeIndexFile, text: string, knownPaths: ReadonlySet<string>): LanguageIndexResult {
  const offsets = lineIndex(text);
  const imports = new Set<string>();
  const symbols: CodeIndexSymbol[] = [];

  for (const match of text.matchAll(SLN_PROJECT)) {
    const name = match[1] ?? "";
    const projectPath = match[2] ?? "";
    const start = match.index ?? 0;
    if (projectPath) imports.add(resolveRelativePath(file.path, projectPath, knownPaths) ?? normalizeSeparators(projectPath));
    if (name) {
      symbols.push({
        id: `${file.path}#${name}`,
        file: file.path,
        name,
        kind: "const",
        exported: true,
        line: lineAt(offsets, start),
        endLine: lineAt(offsets, start),
      });
    }
  }

  return finish(file, imports, symbols);
}

function finish(file: CodeIndexFile, imports: Set<string>, symbols: CodeIndexSymbol[]): LanguageIndexResult {
  const names = symbols.map((symbol) => symbol.name).sort();
  return {
    file: { ...file, imports: [...imports].sort(), exports: names, symbols: names },
    symbols,
    edges: [],
  };
}

/** `..\Core\Core.csproj` → repo kelias, jei toks failas indekse yra. */
function resolveRelativePath(fromFile: string, raw: string, knownPaths: ReadonlySet<string>): string | undefined {
  const segments = fromFile.split("/");
  segments.pop();
  for (const part of normalizeSeparators(raw).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const candidate = segments.join("/");
  return knownPaths.has(candidate) ? candidate : undefined;
}

function normalizeSeparators(value: string): string {
  return value.split("\\").join("/");
}

function baseName(filePath: string): string {
  return filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? filePath;
}
