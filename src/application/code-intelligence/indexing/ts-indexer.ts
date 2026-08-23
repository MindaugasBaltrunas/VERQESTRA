// AST-backed TypeScript indexing (tasks 1105a/1105b, spec IDX-1..IDX-3): per-file
// `ts.createSourceFile` parse + `ts.resolveModuleName` with a shared ModuleResolutionCache;
// deliberately NO `ts.Program` and NO TypeChecker (dispatch hot path + tsconfig-less test
// fixtures). Behaviour etalon: AG_loop code-index/ts-indexer.ts (WBR VQ-301 skaidymas į
// ts-loader / ts-resolve / ts-signatures / ts-source-indexer + šis batch modulis);
// failų tekstai skaitomi per portą, tsconfig'ai — per ts.sys (bibliotekos hostas, 1:1).

import path from "node:path";
import type * as TypeScriptApi from "typescript";
import { toPosixPath } from "../../../shared/paths.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import type { CodeIndexFile } from "./types.js";
import { loadTypeScript } from "./ts-loader.js";
import { indexSourceText, type TypeScriptIndexResult } from "./ts-source-indexer.js";

export type { TypeScriptIndexResult } from "./ts-source-indexer.js";

/**
 * AST-backed index of every `language === "typescript"` file in `scanned`.
 * Returns a map keyed by `CodeIndexFile.path`; non-TypeScript files are absent.
 * Deterministic: iteration order comes from `scanned` (already path-sorted), no clock,
 * no randomness, sequential processing (design §2).
 */
export async function indexTypeScriptFiles(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  scanned: readonly CodeIndexFile[],
): Promise<Map<string, TypeScriptIndexResult>> {
  const ts = await loadTypeScript();
  const knownPaths = new Set(scanned.map((file) => file.path));
  const configByDir = discoverTsconfigOptions(ts, projectRoot, scanned);
  const defaultOptions: TypeScriptApi.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  const cacheByOptions = new Map<TypeScriptApi.CompilerOptions, TypeScriptApi.ModuleResolutionCache>();
  const results = new Map<string, TypeScriptIndexResult>();

  for (const file of scanned) {
    // JavaScript eina per TĄ PATĮ kelią (2026-08-23): `allowJs` ir `NodeNext` rezoliucija jau
    // įjungtos žemiau, o `ts.createSourceFile` `.js/.jsx/.mjs/.cjs` parsina natūraliai. Antras JS
    // parseris būtų antra tiesa tam pačiam klausimui.
    if (file.language !== "typescript" && file.language !== "javascript") {
      continue;
    }
    const absolute = path.join(projectRoot, file.path);
    const text = await fs.readTextFile(absolute);
    const options = nearestAncestorOptions(configByDir, file.path) ?? defaultOptions;
    let cache = cacheByOptions.get(options);
    if (!cache) {
      cache = ts.createModuleResolutionCache(projectRoot, (name) => name, options);
      cacheByOptions.set(options, cache);
    }
    results.set(file.path, indexSourceText(ts, projectRoot, file, text, options, cache, knownPaths));
  }

  return results;
}

// --- tsconfig discovery (design §1, IDX-2) ----------------------------------

function discoverTsconfigOptions(
  ts: typeof TypeScriptApi,
  projectRoot: string,
  scanned: readonly CodeIndexFile[],
): Map<string, TypeScriptApi.CompilerOptions> {
  const configByDir = new Map<string, TypeScriptApi.CompilerOptions>();
  const visited = new Set<string>();
  const configPaths = scanned
    .filter((file) => /^tsconfig(\..+)?\.json$/.test(path.posix.basename(file.path)))
    .map((file) => path.join(projectRoot, file.path));

  const register = (absoluteConfigPath: string): void => {
    const normalized = path.resolve(absoluteConfigPath);
    if (visited.has(normalized)) {
      return;
    }
    visited.add(normalized);
    try {
      const read = ts.readConfigFile(normalized, (readPath) => ts.sys.readFile(readPath));
      if (read.error || !read.config) {
        return; // malformed tsconfig must never break the build (design §1)
      }
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(normalized), undefined, normalized);
      const dir = toPosixPath(path.relative(projectRoot, path.dirname(normalized)));
      configByDir.set(dir === "" ? "." : dir, parsed.options);
      for (const reference of parsed.projectReferences ?? []) {
        const target = reference.path.endsWith(".json") ? reference.path : path.join(reference.path, "tsconfig.json");
        register(path.isAbsolute(target) ? target : path.resolve(path.dirname(normalized), target));
      }
    } catch {
      // Non-fatal by contract: the subtree falls back to default options.
    }
  };

  for (const configPath of configPaths) {
    register(configPath);
  }
  return configByDir;
}

function nearestAncestorOptions(
  configByDir: Map<string, TypeScriptApi.CompilerOptions>,
  filePath: string,
): TypeScriptApi.CompilerOptions | undefined {
  let dir = path.posix.dirname(filePath);
  for (;;) {
    const options = configByDir.get(dir === "" ? "." : dir);
    if (options) {
      return options;
    }
    if (dir === "." || dir === "") {
      return undefined;
    }
    const parent = path.posix.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
