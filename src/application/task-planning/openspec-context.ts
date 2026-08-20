// OpenSpec konteksto ištrauka task tekstui: nuorodų analizė + biudžetuotas failų
// skaitymas. Elgesio etalonas: AG_loop application/task-planning/openspec-context.ts.
// VERQESTRA skirtumai: projekto šaknis paduodama parametru (etalonas ėmė iš runtime
// konteksto — import-time side effect, kurio čia nėra); IO per TaskPlanningFsPort +
// statIsDirectory.

import path from "node:path";
import { normalizeProjectPath, resolveProjectPath } from "../../shared/paths.js";
import type { TaskPlanningFsPort } from "./spec-source.js";

const maxOpenSpecContextChars = 7000;
const maxTouchedSpecs = 5;
const fileBudgets = new Map<string, number>([
  ["openspec/project.md", 1000],
  ["proposal.md", 1400],
  ["design.md", 1200],
  ["tasks.md", 1800],
  ["spec.md", 1400],
]);
const changeFileNames = ["proposal.md", "tasks.md", "spec.md", "design.md"];
const canonicalOpenSpecPrefix = "openspec/";
const agOpenSpecPrefix = "AG/openspec/";

export type OpenSpecContextPorts = {
  fs: TaskPlanningFsPort;
  /** Ar kelias yra katalogas (nesamas/failas — `false`). */
  isDirectory(absolutePath: string): Promise<boolean>;
};

export type OpenSpecReferenceAnalysis = {
  activeChangeDirs: string[];
  archivedChangeDirs: string[];
  templateRefs: string[];
  missingChangeDirs: string[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function pathInsideProject(projectRoot: string, relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized.startsWith(canonicalOpenSpecPrefix) && !normalized.startsWith(agOpenSpecPrefix)) {
    return undefined;
  }

  const agRelative = normalized.startsWith(canonicalOpenSpecPrefix)
    ? `${agOpenSpecPrefix}${normalized.slice(canonicalOpenSpecPrefix.length)}`
    : normalized;
  // Kanoninė „relative escapes root" patikra per shared/paths: resolveProjectPath meta,
  // kai kelias išeina už šaknies; agRelative visada prasideda "AG/openspec/", tad niekada
  // nereziumuoja į pačią šaknį.
  try {
    return resolveProjectPath(projectRoot, agRelative);
  } catch {
    return undefined;
  }
}

function extractOpenSpecChangeRefs(taskText: string): string[] {
  const matches = taskText.match(/(?:AG\/)?openspec\/changes\/(?:archive\/)?[A-Za-z0-9_.-]+/g) ?? [];
  return unique(matches.map((match) => match.replace(/^AG\//, "").replace(/\/+$/, "")));
}

export async function analyzeOpenSpecReferences(
  ports: OpenSpecContextPorts,
  projectRoot: string,
  taskText: string,
): Promise<OpenSpecReferenceAnalysis> {
  const refs = extractOpenSpecChangeRefs(taskText);
  const analysis: OpenSpecReferenceAnalysis = {
    activeChangeDirs: [],
    archivedChangeDirs: [],
    templateRefs: [],
    missingChangeDirs: [],
  };

  for (const ref of refs) {
    if (ref === "openspec/changes/_template") {
      analysis.templateRefs.push(ref);
      continue;
    }

    if (ref.startsWith("openspec/changes/archive/")) {
      analysis.archivedChangeDirs.push(ref);
      continue;
    }

    const absolute = pathInsideProject(projectRoot, ref);
    if (absolute === undefined || !(await ports.isDirectory(absolute))) {
      analysis.missingChangeDirs.push(ref);
      continue;
    }

    analysis.activeChangeDirs.push(ref);
  }

  return {
    activeChangeDirs: unique(analysis.activeChangeDirs).slice(0, 1),
    archivedChangeDirs: unique(analysis.archivedChangeDirs),
    templateRefs: unique(analysis.templateRefs),
    missingChangeDirs: unique(analysis.missingChangeDirs),
  };
}

function extractTouchedSpecs(taskText: string): string[] {
  const candidates: Array<{ specName: string; index: number }> = [];
  const addCandidate = (specName: string | undefined, index: number | undefined): void => {
    if (specName && index !== undefined) {
      candidates.push({ specName, index });
    }
  };

  for (const match of taskText.matchAll(/modules\/([A-Za-z0-9_.-]+-module)/g)) {
    addCandidate(match[1], match.index);
  }

  for (const match of taskText.matchAll(/\b(?:Modulis|Module):\s*([A-Za-z0-9_.-]+-module)\b/g)) {
    addCandidate(match[1], match.index);
  }

  for (const match of taskText.matchAll(/\b[A-Za-z0-9_.-]+-module\b/g)) {
    addCandidate(match[0], match.index);
  }

  const scopedSpecs: Array<{ pattern: RegExp; specName: string }> = [
    { pattern: /\bapps\/api\b|\bModulis:\s*api\b|\bModule:\s*api\b/gi, specName: "api" },
    { pattern: /\bapps\/web\b|\bModulis:\s*web\b|\bModule:\s*web\b/gi, specName: "web" },
    { pattern: /\bapps\/mobile\b|\bModulis:\s*mobile\b|\bModule:\s*mobile\b/gi, specName: "mobile" },
    { pattern: /\bpackages\/db\b|\bModulis:\s*db\b|\bModule:\s*db\b/gi, specName: "db" },
    { pattern: /\bpackages\/core\b|\bModulis:\s*core\b|\bModule:\s*core\b/gi, specName: "core" },
  ];

  for (const scopedSpec of scopedSpecs) {
    for (const match of taskText.matchAll(scopedSpec.pattern)) {
      addCandidate(scopedSpec.specName, match.index);
    }
  }

  return unique(
    candidates
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.specName)
      .filter((specName) => specName.length > 0),
  );
}

function fileBudget(relativePath: string): number {
  return fileBudgets.get(relativePath) ?? fileBudgets.get(path.basename(relativePath)) ?? 1200;
}

async function readOpenSpecFile(
  ports: OpenSpecContextPorts,
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  const absolute = pathInsideProject(projectRoot, relativePath);
  if (!absolute) {
    return "";
  }

  const content = await ports.fs.readTextFileIfExists(absolute);
  if (!content) {
    return "";
  }

  return `## ${normalizeProjectPath(projectRoot, absolute)}\n${content.slice(0, fileBudget(relativePath)).trim()}`;
}

async function readChangeContext(ports: OpenSpecContextPorts, projectRoot: string, changeDir: string): Promise<string[]> {
  const files = changeFileNames.map((fileName) => `${changeDir}/${fileName}`);
  return await Promise.all(files.map((filePath) => readOpenSpecFile(ports, projectRoot, filePath)));
}

async function readSpecContext(ports: OpenSpecContextPorts, projectRoot: string, specNames: string[]): Promise<string[]> {
  return await Promise.all(
    specNames.slice(0, maxTouchedSpecs).map((specName) => readOpenSpecFile(ports, projectRoot, `openspec/specs/${specName}/spec.md`)),
  );
}

export async function buildOpenSpecContext(
  ports: OpenSpecContextPorts,
  projectRoot: string,
  taskText: string,
): Promise<string> {
  const changeDirs = (await analyzeOpenSpecReferences(ports, projectRoot, taskText)).activeChangeDirs;
  const specNames = extractTouchedSpecs(taskText);
  const sections = [
    await readOpenSpecFile(ports, projectRoot, "openspec/project.md"),
    ...(await Promise.all(changeDirs.map((changeDir) => readChangeContext(ports, projectRoot, changeDir)))).flat(),
    ...(await readSpecContext(ports, projectRoot, specNames)),
  ].filter((section) => section.length > 0);

  if (sections.length === 0) {
    return "OpenSpec context not found for this task.";
  }

  return sections.join("\n\n").slice(0, maxOpenSpecContextChars);
}
