// FS pusė „jau įgyvendinta" detekcijai (etalonas: AG_loop architecture/
// architecture-implementation-detector.ts, WBR VQ-501 3/5-d; grynos taisyklės — domain
// implementation-detection, FQC-12). Wave variklis ja žymi mazgus "done" be run-tree
// tasko, kai mazgo kodas repo jau egzistuoja.
//
// Detekcijos tvarka mazgui: (1) projekto node-map (`vq/architecture/node-map.json`) —
// explicit `implemented: true` arba `paths`, kurie VISI privalo egzistuoti (trūkstamas
// kelias = pasenęs map → mazgas eina per normalią sintezę, o ne tyliai praleidžiamas);
// (2) label failų vardai — kiekvienas privalo atitikti bent vieną repo failą (ribotas
// case-insensitive walk; generiniai index.ts ir pan. atmesti ekstraktoriuje); (3) label
// katalogo kandidatai (billing-module, @acme/database → database) po modules/packages/
// apps/workers šaknimis. Mazgas be map įrašo ir be kandidatų NEskipinamas.

import path from "node:path";
import { resolveProjectPath } from "../../shared/paths.js";
import type { ArchitectureNode } from "../../domain/architecture/graph.js";
import {
  extractDirectoryCandidates,
  extractLabelFilenames,
  parseNodeImplementationMap,
  type NodeImplementationMap,
} from "../../domain/architecture/implementation-detection.js";
import type { DirectoryEntry } from "../code-intelligence/ports.js";

export type NodeImplementationDetection = {
  files: string[];
  source: "map" | "map-paths" | "label-filename" | "label-directory";
};

/** Detekcijos FS portas — ArchitectureWaveFsPort jį tenkina struktūriškai. */
export type ImplementationDetectionFsPort = {
  exists(absolutePath: string): Promise<boolean>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Katalogo įrašai; neegzistuojantis katalogas → tuščias sąrašas. */
  listDirectory(absoluteDir: string): Promise<DirectoryEntry[]>;
};

const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  "AG",
  "vq",
  "logs",
  "tmp",
  "storage",
]);

const MAX_WALK_DEPTH = 10;
const MAX_MATCHES_PER_NAME = 10;

export function nodeImplementationMapPath(projectRoot: string): string {
  return path.join(projectRoot, "vq", "architecture", "node-map.json");
}

export async function readNodeImplementationMap(
  fs: ImplementationDetectionFsPort,
  projectRoot: string,
): Promise<NodeImplementationMap> {
  const raw = await fs.readTextFileIfExists(nodeImplementationMapPath(projectRoot));
  if (raw === undefined) return { nodes: {} };
  return parseNodeImplementationMap(raw) ?? { nodes: {} };
}

/**
 * Bounded repo walk collecting files whose basename matches one of `basenames`
 * (case-insensitive). Vendor/build/state dirs are skipped so a stray copy under
 * node_modules or dist can never count as "implemented".
 */
async function findFilesByBasename(
  fs: ImplementationDetectionFsPort,
  projectRoot: string,
  basenames: string[],
): Promise<Map<string, string[]>> {
  const wanted = new Map<string, string>();
  for (const name of basenames) wanted.set(name.toLowerCase(), name);
  const matches = new Map<string, string[]>();
  for (const name of basenames) matches.set(name, []);

  async function walk(dirAbs: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    for (const entry of await fs.listDirectory(dirAbs)) {
      if (entry.isDirectory) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(dirAbs, entry.name), depth + 1);
      } else if (entry.isFile) {
        const original = wanted.get(entry.name.toLowerCase());
        if (!original) continue;
        const found = matches.get(original)!;
        if (found.length >= MAX_MATCHES_PER_NAME) continue;
        found.push(path.relative(projectRoot, path.join(dirAbs, entry.name)).replace(/\\/g, "/"));
      }
    }
  }

  if (basenames.length > 0) await walk(projectRoot, 0);
  return matches;
}

const DIRECTORY_ROOTS = ["modules", "packages", "apps", "workers"];

async function resolveDirectoryCandidate(
  fs: ImplementationDetectionFsPort,
  projectRoot: string,
  token: string,
): Promise<string | null> {
  for (const root of DIRECTORY_ROOTS) {
    const rel = `${root}/${token}`;
    if (await fs.exists(path.join(projectRoot, rel))) return rel;
  }
  return null;
}

export async function detectNodeImplementation(
  fs: ImplementationDetectionFsPort,
  projectRoot: string,
  node: ArchitectureNode,
  map: NodeImplementationMap,
): Promise<NodeImplementationDetection | null> {
  const entry = map.nodes[node.id];
  if (entry) {
    const declaredPaths = entry.paths ?? [];
    const existing: string[] = [];
    for (const rel of declaredPaths) {
      let resolved: string;
      try {
        resolved = resolveProjectPath(projectRoot, rel, { allowAbsoluteInsideRoot: false }, "node implementation path");
      } catch {
        continue;
      }
      if (await fs.exists(resolved)) existing.push(rel);
    }
    if (entry.implemented === true) {
      return { files: existing, source: "map" };
    }
    if (declaredPaths.length > 0) {
      // Explicit map entry with a missing path = stale map. Do NOT fall through to the
      // fuzzier label heuristics — the operator declared intent; let the node go through
      // normal synthesis so the gap becomes visible instead of silently skipped.
      return existing.length === declaredPaths.length ? { files: existing, source: "map-paths" } : null;
    }
    return null;
  }

  const filenames = extractLabelFilenames(node.label);
  if (filenames.length > 0) {
    const matches = await findFilesByBasename(fs, projectRoot, filenames);
    const files = filenames.flatMap((name) => matches.get(name) ?? []);
    if (filenames.every((name) => (matches.get(name) ?? []).length > 0)) {
      return { files, source: "label-filename" };
    }
    return null;
  }

  const tokens = extractDirectoryCandidates(node.label);
  if (tokens.length > 0) {
    const dirs: string[] = [];
    for (const token of tokens) {
      const resolved = await resolveDirectoryCandidate(fs, projectRoot, token);
      if (!resolved) return null;
      dirs.push(resolved);
    }
    return { files: dirs, source: "label-directory" };
  }

  return null;
}
