// Import specifier rezoliucija (design §4). Behaviour etalon: AG_loop code-index/
// ts-indexer.ts resolveSpecifier/importPathCandidates. `ts.sys` čia yra typescript
// bibliotekos modulio-rezoliucijos hostas — trečiosios šalies priklausomybės elgesys,
// sąmoningai paliktas 1:1 (jo pakeitimas custom hostu keistų rezoliucijos elgseną).

import path from "node:path";
import type * as TypeScriptApi from "typescript";
import { toPosixPath } from "../../../shared/paths.js";

export function resolveSpecifier(
  ts: typeof TypeScriptApi,
  projectRoot: string,
  fromPath: string,
  specifier: string,
  options: TypeScriptApi.CompilerOptions,
  cache: TypeScriptApi.ModuleResolutionCache,
  knownPaths: Set<string>,
): { value: string; inRepo: boolean } {
  const containingFile = path.join(projectRoot, fromPath);
  const resolution = ts.resolveModuleName(specifier, containingFile, options, ts.sys, cache);
  const resolved = resolution.resolvedModule;
  if (resolved && !resolved.isExternalLibraryImport) {
    const relative = toPosixPath(path.relative(projectRoot, resolved.resolvedFileName));
    if (!relative.startsWith("..") && !relative.includes("node_modules/") && knownPaths.has(relative)) {
      return { value: relative, inRepo: true };
    }
  }
  if (specifier.startsWith(".")) {
    // Unresolvable relative import must still yield a path-shaped token (design §4 step 3).
    const base = toPosixPath(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier)));
    const candidate = importPathCandidates(base).find((entry) => knownPaths.has(entry));
    return candidate ? { value: candidate, inRepo: true } : { value: base, inRepo: false };
  }
  // Bare specifier (zod, node:fs, @scope/pkg) stays raw — architecture-boundary external
  // token matching depends on the verbatim form (design §4 step 4).
  return { value: specifier, inRepo: false };
}

export function importPathCandidates(base: string): string[] {
  const extension = path.posix.extname(base);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const withoutExtension = base.slice(0, -extension.length);
    return [
      `${withoutExtension}.ts`,
      `${withoutExtension}.tsx`,
      base,
      `${withoutExtension}.js`,
      `${withoutExtension}.jsx`,
      `${withoutExtension}.mjs`,
      `${withoutExtension}.cjs`,
    ];
  }

  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
}
