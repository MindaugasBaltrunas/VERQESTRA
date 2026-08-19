// Bendri ištraukimo helper'iai digest parser'iams: file:line lokacijos, vardų/skaičių/
// expectation rinkimas. Behaviour etalon: AG_loop domain/tool-results/
// bash-output-digest.ts (extraction pusė; WBR VQ-204 skaidymas).

// `file.ext:line[:col]`, including Windows drive-letter and backslash paths. The leading
// guard keeps `http://host:80` style text out of the location list.
const LOCATION_PATTERN = /((?:[A-Za-z]:)?[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md)):(\d+)(?::(\d+))?/g;

export function extractLocations(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(LOCATION_PATTERN)) {
    const [, file, row, column] = match;
    if (!file || !row) continue;
    found.push(`${file}:${row}${column ? `:${column}` : ""}`);
  }
  return found;
}

export function pushName(target: string[], value: string | undefined): void {
  const name = value?.trim() ?? "";
  if (name.length > 0) target.push(name);
}

export function readCount(line: string, pattern: RegExp, group: number, assign: (value: number) => void): boolean {
  const match = pattern.exec(line);
  const raw = match?.[group];
  if (raw === undefined) return false;
  assign(Number(raw));
  return true;
}

export function collectExpectation(line: string, pattern: RegExp, target: string[]): void {
  const match = pattern.exec(line);
  if (match?.[1]) target.push(match[1]);
}
