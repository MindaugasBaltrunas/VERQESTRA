// Projekto failų skenavimas ir source hash. Behaviour etalon: AG_loop code-index/scanner.ts;
// FS — per CodeIntelligenceFileSystemPort (WBR VQ-301), hash — node:crypto (leistas application).

import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeProjectPath, toPosixPath } from "../../../shared/paths.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { indexedCodeExtensions, languageForExtension, sourceHashLanguages } from "./language-capabilities.js";
import type { CodeIndexFile, CodeIndexFileKind } from "./types.js";

const indexedExtensions = indexedCodeExtensions();
// ".claude" excludes the executor's own worktree/session state (isolated checkouts can
// contain a full nested copy of the repo's source tree and would be double-scanned).
// ".ag"/".ag-worktrees"/".vq-worktrees" — izoliuotos darbo kopijos: gyvo lygiagretaus
// run'o metu ten guli PILNA repo kopija, kuri be šio įrašo padvigubintų import grafą.
const ignoredSegments = new Set([
  ".git",
  ".claude",
  ".ag",
  ".ag-worktrees",
  ".vq-worktrees",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "bin",
  "obj",
  "__pycache__",
]);
// Runtime medžiai, kurie nėra produkto kodas. AG_loop prefiksai palikti, kad indeksas,
// paleistas ant AG-formos target projekto, elgtųsi identiškai; vq/ — VERQESTRA runtime.
const ignoredRuntimePrefixes = [
  "AG/state",
  "AG/logs",
  "AG/supervisor",
  "AG/tasks",
  "AG/orchestrator/dist",
  "AG/orchestrator/docs",
  "AG/orchestrator/ui-app/node_modules",
  "vq/state",
  "vq/logs",
];

export async function scanProjectFiles(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexFile[]> {
  const root = path.resolve(projectRoot);
  const files: CodeIndexFile[] = [];
  await walk(fs, root, root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function computeSourceHash(files: CodeIndexFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files.filter(isSourceHashFile)) {
    hash.update(file.path);
    hash.update(String.fromCharCode(0));
    hash.update(file.hash);
    hash.update(String.fromCharCode(0));
  }
  return Promise.resolve(hash.digest("hex"));
}

export function isSourceHashFile(file: CodeIndexFile): boolean {
  return sourceHashLanguages().has(file.language) || file.kind === "config";
}

export async function hashFile(fs: CodeIntelligenceFileSystemPort, filePath: string): Promise<string> {
  const content = await fs.readFileBytes(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function walk(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  currentDir: string,
  files: CodeIndexFile[],
): Promise<void> {
  const entries = await fs.listDirectory(currentDir);
  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    const relative = normalizeProjectPath(projectRoot, absolute);
    if (shouldIgnore(relative, entry.name)) {
      continue;
    }

    if (entry.isDirectory) {
      await walk(fs, projectRoot, absolute, files);
      continue;
    }

    if (!entry.isFile || !indexedExtensions.has(extensionForFile(entry.name))) {
      continue;
    }

    files.push({
      path: toPosixPath(relative),
      hash: await hashFile(fs, absolute),
      size: await fs.fileSize(absolute),
      language: languageForExtension(extensionForFile(entry.name)),
      kind: kindForFile(relative),
      imports: [],
      exports: [],
      symbols: [],
      isTest: isTestPath(relative),
    });
  }
}

function shouldIgnore(relativePath: string, entryName: string): boolean {
  if (ignoredSegments.has(entryName)) {
    return true;
  }
  const normalized = toPosixPath(relativePath);
  return ignoredRuntimePrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function extensionForFile(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csproj")) return ".csproj";
  if (lower.endsWith(".sln")) return ".sln";
  if (lower.endsWith(".props")) return ".props";
  if (lower.endsWith(".targets")) return ".targets";
  return path.extname(lower);
}

function kindForFile(relativePath: string): CodeIndexFileKind {
  const normalized = toPosixPath(relativePath);
  if (isTestPath(normalized)) return "test";
  if (/\b(config|package|tsconfig|eslint|vite|vitest|pyproject|composer|csproj|sln)\b/i.test(path.basename(normalized)))
    return "config";
  return "source";
}

function isTestPath(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath);
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(normalized) ||
    /\.(test|spec)\.[tj]sx?$/i.test(normalized) ||
    /(^|\/)(test_|.*_test)\.py$/i.test(normalized) ||
    /(^|\/).*Test\.php$/i.test(normalized) ||
    /(^|\/).*Tests?\.cs$/i.test(normalized)
  );
}
