// Produkto paketų ŠAKNŲ aptikimas medyje (etalonas: AG_loop orchestrator/loop/slot-task-runner.ts
// workspace dalis).
//
// Šaknys aptinkamos iš PAČIO medžio manifestų, o ne iš įrašyto sąrašo: šis loop'as diegiamas į BET
// KOKĮ repo, tad fiksuotas „AG/mobile-app" tipo sąrašas būtų teisingas lygiai vienoje
// repozitorijoje. Rezultatas rūšiuojamas — bootstrap'as privalo būti deterministinis.
//
// Šablonų parsinimas laikomas GRYNAS ir eksportuojamas atskirai: būtent jame gyvena visos
// kraštinės formos (komentarai, kabutės, neigimai, `**`), ir jas reikia tikrinti be failų sistemos.

import { readdir } from "node:fs/promises";
import path from "node:path";

/** Kiek katalogų lygių gilyn skenuoja `**` globas — apsauga nuo viso medžio apėjimo. */
export const WORKSPACE_GLOB_MAX_DEPTH = 4;

/**
 * `packages:` sąrašas iš `pnpm-workspace.yaml` BE YAML parserio priklausomybės: tai plokščias
 * eilučių sąrašas, kurio formatą pnpm ir taip riboja.
 *
 * Nežinomos ar neigiamos (`!`) reikšmės saugios — jos tiesiog neišsiskleidžia į egzistuojantį
 * katalogą su `package.json`, tad klaidingas šablonas duoda mažiau šaknų, o ne svetimų.
 */
export function parsePnpmWorkspacePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (!inPackages) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      continue;
    }
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    // Naujas top-level raktas — sąrašas baigėsi. Skaityti toliau reikštų imti svetimą sekciją.
    if (item?.[1] === undefined) break;
    const value = item[1]
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length > 0) patterns.push(value);
  }
  return patterns;
}

/** npm/yarn/bun workspaces iš šakninio `package.json` (`string[]` arba `{ packages: string[] }`). */
export function parseManifestWorkspacePatterns(manifest: string): string[] {
  try {
    const parsed: unknown = JSON.parse(manifest);
    const field = (parsed as { workspaces?: unknown } | null)?.workspaces;
    const list = Array.isArray(field) ? field : (field as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // Sugadintas manifest'as reiškia „workspace'ų nežinome", ne klaidą: šaknis vis tiek kandidatė.
    return [];
  }
}

/** Vieno segmento globas (`*`, `ui-*`) → regexp. Kiti regexp simboliai escape'inami. */
export function globSegmentMatcher(segment: string): RegExp {
  const pattern = segment.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? "[^/]*" : `\\${char}`));
  return new RegExp(`^${pattern}$`);
}

/** Katalogo pakatalogiai be `node_modules` ir be dot-katalogų (juose workspace paketų nebūna). */
async function listPackageDirectories(baseAbs: string): Promise<string[]> {
  try {
    const entries = await readdir(baseAbs, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** `**` segmentui: visi palikuonys iki `WORKSPACE_GLOB_MAX_DEPTH` lygių, reliatyvūs `baseAbs`. */
async function listDescendantDirectories(baseAbs: string, depth: number): Promise<string[]> {
  if (depth <= 0) return [];
  const found: string[] = [];
  for (const name of await listPackageDirectories(baseAbs)) {
    found.push(name);
    for (const nested of await listDescendantDirectories(path.join(baseAbs, name), depth - 1)) {
      found.push(`${name}/${nested}`);
    }
  }
  return found;
}

/** Workspace šablono (`packages/*`, `apps/**`) išskleidimas medyje. */
export async function expandWorkspacePattern(treeAbs: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  let current = [""];
  for (const segment of segments) {
    const next = new Set<string>();
    for (const base of current) {
      const baseAbs = base === "" ? treeAbs : path.join(treeAbs, ...base.split("/"));
      const join = (name: string): string => (base === "" ? name : `${base}/${name}`);
      if (segment === "**") {
        if (base !== "") next.add(base);
        for (const descendant of await listDescendantDirectories(baseAbs, WORKSPACE_GLOB_MAX_DEPTH)) next.add(join(descendant));
      } else if (segment.includes("*")) {
        const matcher = globSegmentMatcher(segment);
        for (const name of await listPackageDirectories(baseAbs)) if (matcher.test(name)) next.add(join(name));
      } else {
        // Literalus segmentas: egzistavimas tikrinamas vėliau, kartu su `package.json` filtru.
        next.add(join(segment));
      }
    }
    current = [...next];
  }
  return current;
}

export type DiscoverProductRootsInput = {
  treeAbs: string;
  readFileIfExists: (absolutePath: string) => Promise<string | undefined>;
  pathExists: (absolutePath: string) => Promise<boolean>;
  /** Šaknys, kurias tvarko atskiras žingsnis (pvz. jau sujunction'inta runtime šaknis). */
  skip?: readonly string[];
};

/** Repo-reliatyvus posix kelias → absoliutus kelias medyje (`.` reiškia patį medį). */
export function resolveTreePath(treeAbs: string, relative: string, ...tail: string[]): string {
  return path.join(treeAbs, ...relative.split("/"), ...tail);
}

export async function discoverProductRoots(input: DiscoverProductRootsInput): Promise<string[]> {
  const workspaceYaml = await input.readFileIfExists(path.join(input.treeAbs, "pnpm-workspace.yaml"));
  const manifest = await input.readFileIfExists(path.join(input.treeAbs, "package.json"));
  const patterns =
    workspaceYaml === undefined
      ? manifest === undefined
        ? []
        : parseManifestWorkspacePatterns(manifest)
      : parsePnpmWorkspacePatterns(workspaceYaml);

  // Šaknis VISADA kandidatė: net vieno paketo projekte būtent joje gyvena `node_modules`.
  const candidates = new Set<string>(["."]);
  for (const pattern of patterns) {
    for (const candidate of await expandWorkspacePattern(input.treeAbs, pattern)) {
      if (candidate.length > 0) candidates.add(candidate);
    }
  }

  const skip = new Set(input.skip ?? []);
  const roots: string[] = [];
  for (const root of candidates) {
    if (skip.has(root)) continue;
    if (await input.pathExists(resolveTreePath(input.treeAbs, root, "package.json"))) roots.push(root);
  }
  return roots.sort();
}
