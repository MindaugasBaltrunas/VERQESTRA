// Readiness auditas: ar repo turi deklaruotus aplankus, konfigus, komandas, testus ir
// docs. Elgesio etalonas: AG_loop orchestrator/quality/readiness-audit.ts. VERQESTRA
// skirtumai: reikalavimų sąrašai yra PRIVALOMA įvestis (kaip run-wave-gates `gates`) —
// etalono sąrašai aprašė AG_loop layout'ą ir čia būtų melas; IO per ReadinessPorts;
// rezultato persist'inimas — kvietėjo darbas (kelias — readinessAuditResultPath).

import path from "node:path";

export type ReadinessCategory = "folders" | "configs" | "commands" | "tests" | "docs";
export type ReadinessCategoryResult = { status: "ok" | "missing"; missing: string[] };
export type ReadinessAuditResult = {
  status: "ok" | "not_ready";
  categories: Record<ReadinessCategory, ReadinessCategoryResult>;
  documented_commands: string[];
  implemented_commands: string[];
  undocumented_commands: string[];
  missing_areas: ReadinessCategory[];
};

/**
 * Ko repo PRIVALO turėti, kad būtų paruoštas. Sąrašai — projekto-root-relative keliai.
 * `commandSources` — failai, kuriuose registruojamos CLI komandos (`{ name: "..." }`
 * įrašai); dokumentuotos komandos imamos iš README „## Main Commands" sekcijos.
 */
export type ReadinessRequirements = {
  folders: readonly string[];
  configs: readonly string[];
  tests: readonly string[];
  docs: readonly string[];
  commandSources: readonly string[];
};

export type ReadinessPorts = {
  /** `file` | `directory` | `absent` (symlink/kita — `absent`: reikalavimas netenkinamas). */
  statKind(absolutePath: string): Promise<"file" | "directory" | "absent">;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

/** `vq/state/readiness-audit-result.json` — kur kompozicija persistina verdiktą. */
export function readinessAuditResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "readiness-audit-result.json");
}

export function parseReadmeMainCommands(readme: string): string[] {
  const heading = /^## Main Commands\s*$/im.exec(readme);
  if (!heading) return [];
  const sectionStart = heading.index + heading[0].length;
  const remainder = readme.slice(sectionStart);
  const nextHeading = /^## /m.exec(remainder);
  const section = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
  const commands = new Set<string>();
  // Binaro vardas yra `verqestra` (package.json bin), tad TIK jis ir laikomas dokumentacija.
  // Etalono `ag` forma SAMONINGAI nebepriimama: README, siulantis komanda, kurios nera, yra
  // neteisingas README -- o priimdamas abi formas auditas toki README praleistu kaip
  // dokumentuota. Nukrypimas nuo etalono yra GRIEZTINANTIS (priimamu formu maziau).
  for (const match of section.matchAll(/(?:pnpm\s+verqestra|\bverqestra)\s+([a-z][a-z0-9-]*)/gi)) {
    if (match[1] !== undefined) commands.add(match[1]);
  }
  return [...commands];
}

export function parseRegisteredCommands(sources: readonly string[]): string[] {
  const commands = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\{\s*name:\s*["']([a-z][a-z0-9-]*)["']/g)) {
      if (match[1] !== undefined) commands.add(match[1]);
    }
  }
  return [...commands].sort();
}

export async function runReadinessAudit(
  ports: ReadinessPorts,
  projectRoot: string,
  requirements: ReadinessRequirements,
): Promise<ReadinessAuditResult> {
  const root = path.resolve(projectRoot);
  const folderMissing = await missingPaths(ports, root, requirements.folders, "directory");
  const configMissing = await missingPaths(ports, root, requirements.configs, "file");
  const docMissing = await missingPaths(ports, root, requirements.docs, "file", true);

  const readme = await ports.readTextFileIfExists(path.join(root, "README.md"));
  const documentedCommands = parseReadmeMainCommands(readme ?? "");
  const registrySources = await Promise.all(
    requirements.commandSources.map((source) => ports.readTextFileIfExists(path.join(root, ...source.split("/")))),
  );
  const implementedCommands = parseRegisteredCommands(
    registrySources.filter((source): source is string => source !== undefined),
  );
  const unimplementedCommands = documentedCommands.filter((command) => !implementedCommands.includes(command));
  const undocumentedCommands = implementedCommands.filter((command) => !documentedCommands.includes(command));
  const commandMissing = [
    ...unimplementedCommands.map((command) => `implementation:${command}`),
    ...undocumentedCommands.map((command) => `documentation:${command}`),
  ];
  const testMissing = await missingPaths(ports, root, requirements.tests, "file");

  const categories: ReadinessAuditResult["categories"] = {
    folders: category(folderMissing),
    configs: category(configMissing),
    commands: category(commandMissing),
    tests: category(testMissing),
    docs: category(docMissing),
  };
  const missingAreas = (Object.keys(categories) as ReadinessCategory[]).filter((name) => categories[name].status !== "ok");
  return {
    status: missingAreas.length === 0 ? "ok" : "not_ready",
    categories,
    documented_commands: documentedCommands,
    implemented_commands: implementedCommands,
    undocumented_commands: undocumentedCommands,
    missing_areas: missingAreas,
  };
}

export function renderReadinessAudit(result: ReadinessAuditResult): string {
  const lines = [`Readiness audit: ${result.status}`];
  for (const [name, value] of Object.entries(result.categories)) {
    lines.push(`${name}: ${value.status}${value.missing.length ? ` (missing: ${value.missing.join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

function category(missing: string[]): ReadinessCategoryResult {
  return { status: missing.length === 0 ? "ok" : "missing", missing };
}

async function missingPaths(
  ports: ReadinessPorts,
  root: string,
  relativePaths: readonly string[],
  kind: "file" | "directory",
  requireContent = false,
): Promise<string[]> {
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    const absolute = path.join(root, ...relativePath.split("/"));
    const found = await ports.statKind(absolute);
    if (found !== kind) {
      missing.push(relativePath);
      continue;
    }
    if (requireContent && kind === "file" && !((await ports.readTextFileIfExists(absolute)) ?? "").trim()) {
      missing.push(relativePath);
    }
  }
  return missing;
}
