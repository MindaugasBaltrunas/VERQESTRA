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

/**
 * Extract the relative link targets from markdown `[text](target)` links (etalono
 * domain/docs/markdown-links.ts — VERQESTRA namas čia, prie kitų grynų markdown taisyklių).
 * Naudoja release/audit README link-integrity vartai.
 *
 * Only targets that point at repository-local paths are returned. The following are skipped
 * because they are not file references we can resolve on disk: external schemes (`http:`,
 * `mailto:`, …) and protocol-relative `//` links, pure in-page anchors (`#section`), empty
 * targets. Titles (`(path "title")`) and `#anchor` fragments are stripped, angle-bracket
 * `<path>` wrappers are removed, and results are de-duplicated in first-seen order.
 */
export function extractRelativeMarkdownLinks(markdown: string): string[] {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const match of markdown.matchAll(linkPattern)) {
    const target = normalizeLinkTarget(match[1] ?? "");
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }

  return targets;
}

function normalizeLinkTarget(raw: string): string | undefined {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  // Drop an optional `"title"`/`'title'` that follows whitespace after the URL.
  const whitespaceIndex = target.search(/\s/);
  if (whitespaceIndex !== -1) target = target.slice(0, whitespaceIndex);
  // Drop an in-target `#anchor` fragment.
  const anchorIndex = target.indexOf("#");
  if (anchorIndex !== -1) target = target.slice(0, anchorIndex);
  target = target.trim();

  if (target.length === 0) return undefined;
  if (target.startsWith("//")) return undefined; // protocol-relative external
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined; // http:, https:, mailto:, …
  return target;
}
