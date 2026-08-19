// Generic markdown helpers: heading/section extraction parameterized by heading text and
// level. No domain knowledge — callers own their heading names. Behaviour etalon:
// AG_loop shared/markdown (the CANONICAL section extractor — do not add another one).

const BULLET_PREFIX = /^[-*]\s+/;

export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** Leading bullet marker (`- `/`* `) stripped from a single line, trimmed. */
export function stripBulletPrefix(line: string): string {
  return line.trim().replace(BULLET_PREFIX, "").trim();
}

/** Text of the first ATX heading at the given level (default 1), or undefined if none. */
export function firstHeading(content: string, level: number = 1): string | undefined {
  const marker = "#".repeat(level);
  const pattern = new RegExp(`^${marker}(?!#)\\s+(.+)$`);
  for (const rawLine of splitLines(content)) {
    const match = pattern.exec(rawLine.trim());
    const captured = match?.[1];
    if (captured !== undefined) return captured.trim();
  }
  return undefined;
}

/**
 * Body text under a heading matching `heading` exactly (e.g. `"## Patikra"`), up to the
 * next ATX heading of any level (1-6) or end of document. Empty string when not found.
 */
export function extractSection(content: string, heading: string): string {
  const lines = splitLines(content);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || /^#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}
