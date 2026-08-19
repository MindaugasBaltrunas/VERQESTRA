// Grynos kelio pagalbinės funkcijos (node:path-free) — domain sluoksnis builtin'ų neturi,
// o progress ledger'yje saugomi keliai visada yra repo-relative forward-slash eilutės.
// Semantika 1:1 su node:path (dirname/basename/extname), įskaitant dotfile taisyklę
// (".env" → ext ""). Vienintelis šaltinis architecture moduliams (FQC-12) — anksčiau
// šie helper'iai buvo inline node-verification-rules.ts, o interface-inference importavo
// node:path; WBR VQ-204 inversija abu suvienodina čia.

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** node:path.dirname atitikmuo repo-relative keliams. */
export function dirOf(relPath: string): string {
  const p = normalizeSlashes(relPath).replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

/** node:path.basename atitikmuo. */
export function baseOf(relPath: string): string {
  const p = normalizeSlashes(relPath).replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Skaido failo vardą į `{ base, ext }` pagal node:path.extname/basename semantiką. */
export function splitExt(fileName: string): { base: string; ext: string } {
  const dot = fileName.lastIndexOf(".");
  // dot <= 0 dengia „be plėtinio" ir dotfile (".env") — node:path abiem atveju ext "".
  if (dot <= 0) return { base: fileName, ext: "" };
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) };
}
