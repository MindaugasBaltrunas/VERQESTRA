// Grynos (be FS) funkcijos failų lygio našlaičių paieškai.
//
// `dead-export-gate.test.ts` vartas yra TOKEN'INIS: simbolis laikomas gyvu, jei jo VARDĄ mini
// bet kuris kitas failas. Pilnas failo dublikatas su bendravardžiais eksportais tam vartui
// nematomas iš principo — abi kopijos „patvirtina" viena kitą. Šis modulis mato KELIUS, ne
// vardus: failas gyvas tik jei jo KELIĄ specifikatoriuje mini kitas failas arba jis yra
// entrypoint'as.
//
// SVARBI SKIRTIS nuo token'inio varto: failų lygiui `export ... from "./x.js"` YRA importas —
// barrel'io taikinys nėra našlaitis. Token'inis vartas re-eksportus ignoruoja (nes pats simbolio
// vardas ten nenaudojamas), bet failo pasiekiamumo klausimui barrel'io nuoroda į kelią yra
// tikras ryšys.
import path from "node:path";

const STATIC_IMPORT = /import\s+(?:[^'"();]+?\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_FROM = /export\s+[^'"();]*?\bfrom\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Iš teksto ištraukia visus `import`/`export ... from`/dinaminio `import()` specifikatorius. */
export function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_IMPORT, EXPORT_FROM, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Santykinį (`./`, `../`) specifikatorių verčia repo-santykiniu `.ts` keliu. Ne-santykiniai
 * specifikatoriai (paketai, `node:` builtin'ai) grąžina `undefined` — jie niekada nenurodo į
 * src failą.
 */
export function resolveSpecifier(fromRelative: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const fromDir = path.posix.dirname(fromRelative);
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (joined.endsWith(".js")) return `${joined.slice(0, -3)}.ts`;
  return joined.endsWith(".ts") ? joined : `${joined}.ts`;
}

export type OrphanScanFile = {
  readonly relative: string;
  readonly source: string;
};

/**
 * Grąžina produkcinius (ne `tests/`) failus, kurių kelio nemini nė vieno KITO failo
 * specifikatoriai ir kurių nėra `entrypoints`.
 */
export function findOrphanFiles(files: ReadonlyArray<OrphanScanFile>, entrypoints: ReadonlySet<string>): string[] {
  const mentionedBy = new Map<string, Set<string>>();
  for (const file of files) {
    for (const specifier of collectImportSpecifiers(file.source)) {
      const resolved = resolveSpecifier(file.relative, specifier);
      if (resolved === undefined) continue;
      const mentioners = mentionedBy.get(resolved) ?? new Set<string>();
      mentioners.add(file.relative);
      mentionedBy.set(resolved, mentioners);
    }
  }

  const orphans: string[] = [];
  for (const file of files) {
    if (file.relative.startsWith("tests/")) continue;
    if (entrypoints.has(file.relative)) continue;
    const mentioners = mentionedBy.get(file.relative);
    const mentionedByOther = mentioners !== undefined && [...mentioners].some((mentioner) => mentioner !== file.relative);
    if (mentionedByOther) continue;
    orphans.push(file.relative);
  }
  return orphans;
}
