// quality-gates use case (etalono application/quality-gates/spec-drift.ts, WBR VQ-305):
// lygina pakeistus failus su spec change deklaruotais scope glob'ais ir persistuoja rezultatą
// (`vq/state/spec-drift-result.json`) per portą. CLI rendinimas/exit — E5; spec change
// skaitymas, changed-files surinkimas ir spec politikos vartas — per `SpecDriftPorts`.
// Vartoja milestone-check use case'as (release-readiness, VQ-305 3/3).
import path from "node:path";
import { toComparablePosixPath as normalizeToken } from "../../shared/paths.js";

export type SpecDriftStatus = "ok" | "warning" | "review-required";

export type SpecDriftResult = {
  change_id: string;
  status: SpecDriftStatus;
  scope: string[];
  files: string[];
  outside_scope: string[];
  warnings: string[];
  result_path: string;
};

export type SpecChange = {
  id?: string;
  scope?: unknown;
};

export type SpecDriftPorts = {
  /**
   * Egzistavimo/schemos vartas `spec-policy.json` failui. Etalono PC-SPEC-01/924-03
   * sprendimas: politikos `required`/`optional` yra DARBO kategorijų proza, ne failų scope —
   * jos turinys čia sąmoningai nenaudojamas, bet sugadintas/trūkstamas failas privalo mesti.
   */
  assertSpecPolicy(): Promise<void>;
  /** Spec change įrašas; meta `Spec change not found: <id>`, kai jo nėra. */
  readSpecChange(changeId: string): Promise<SpecChange>;
  /** Pakeistų failų sąrašas (git status — E4 adapteris); klaida = tuščias sąrašas adapteryje. */
  changedFiles(): Promise<string[]>;
  writeResult(result: SpecDriftResult): Promise<void>;
};

/** `vq/state/spec-drift-result.json` — rezultato failas (rašo adapteris). */
export function specDriftResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "spec-drift-result.json");
}

export async function specDrift(
  ports: SpecDriftPorts,
  args: string[],
  projectRoot = process.cwd(),
): Promise<SpecDriftResult> {
  const changeId = args[0]?.trim();
  if (!changeId) {
    throw new Error("Usage: verqestra spec-drift <change-id> [changed-file ...]");
  }

  const root = path.resolve(projectRoot);
  await ports.assertSpecPolicy();

  const change = await ports.readSpecChange(changeId);
  const scope = normalizeScope(change.scope);
  const files = normalizeFiles(parseProvidedFiles(args.slice(1)));
  const changedFiles = files.length > 0 ? files : normalizeFiles(await ports.changedFiles());
  const outsideScope = changedFiles.filter((file) => !isFileInScope(file, scope));
  const warnings: string[] = [];

  if (scope.length === 0) {
    warnings.push("spec change scope is empty");
  }
  if (changedFiles.length === 0) {
    warnings.push("no changed files provided or detected");
  }

  const status: SpecDriftStatus = outsideScope.length > 0 ? "review-required" : warnings.length > 0 ? "warning" : "ok";
  const resultPath = specDriftResultPath(path.join(root, "vq"));
  const result: SpecDriftResult = {
    change_id: changeId,
    status,
    scope,
    files: changedFiles,
    outside_scope: outsideScope,
    warnings,
    result_path: path.relative(root, resultPath).replace(/\\/g, "/"),
  };

  await ports.writeResult(result);
  return result;
}

export function normalizeScope(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(normalizeToken);
}

export function parseProvidedFiles(args: string[]): string[] {
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--files=")) {
      files.push(...arg.slice("--files=".length).split(","));
    } else if (!arg.startsWith("--")) {
      files.push(arg);
    }
  }
  return files;
}

function normalizeFiles(files: string[]): string[] {
  return Array.from(new Set(files.map(normalizeToken).filter(Boolean))).sort();
}

export function isFileInScope(filePath: string, scope: string[]): boolean {
  if (scope.length === 0) return false;
  const file = normalizeToken(filePath);
  return scope.some((entry) => matchesScope(file, entry));
}

function matchesScope(file: string, scope: string): boolean {
  if (scope === "**" || scope === "*") return true;
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (scope.includes("/")) {
    const prefix = scope.replace(/\/$/, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }

  const fragments = scope.split("-").filter(Boolean);
  return fragments.every((fragment) => file.includes(fragment));
}
