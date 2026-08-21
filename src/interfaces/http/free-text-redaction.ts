// Laisvo teksto redakcija prieš išleidžiant jį į UI (etalonas: AG_loop
// interfaces/http/ui-waves-view.ts sanitize blokas).
//
// Taisyklė: loopback NĖRA priežastis atskleisti disko struktūrą ar nuosavybės identifikatorius.
// Diagnostikos vaizdai neša laisvą tekstą iš logų ir atmetimų detalių, o tame tekste sėdi disko
// raidė, vartotojo vardas ir įdiegimo vieta.
//
// Perteklinis nukirpimas yra SAUGI pusė: nutekėjęs absoliutus kelias — ne.

import path from "node:path";

// Drive- arba UNC-anchored Windows kelias ryjamas IKI kabutės, `|` ar eilutės pabaigos, o ne iki
// pirmo tarpo: `C:\Program Files\...` ir `C:\Users\John Doe\...` tarpą turi savo viduje, tad tarpu
// ribotas šablonas paliktų beveik visą kelią matomą.
const windowsPathPattern = /(?:[A-Za-z]:[\\/]|\\\\)[^'"|\r\n]*/g;

// Absoliutus POSIX kelias: `/` po ne-žodinio simbolio ir bent vienas pilnas segmentas. Unicode
// klasės, kad `/home/vartotojas/ąžuolas/...` nenutrūktų ties pirma ne-ASCII raide. SANTYKINIAI
// keliai (`src/x.ts`) lieka matomi — būtent jie yra atsakymas į „kodėl du task'ai nepraėjo pro
// nepriklausomumo vartus".
const posixPathPattern = /(?<![\p{L}\p{N}_~])\/(?:[\p{L}\p{N}._@+-]+\/)+[\p{L}\p{N}._@+-]*/gu;

/** Lease ir attempt identifikatoriai — atmetimų detalės juos įterpia į laisvą tekstą. */
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Žinomų šaknų (projekto šaknis, namų katalogas) šablonai abiem separatorių lytimis.
 *
 * Šaknys valomos PIRMOS ir pažodžiui, nes būtent jos neša tai, kas tikrai neturi išeiti. Formos
 * šablonai lieka antra gynybos linija svetimiems keliams. Windows lyginama be raidžių lyties —
 * ten failų sistema irgi jos neskiria.
 */
function rootPatterns(roots: readonly string[], platform: NodeJS.Platform): RegExp[] {
  const flags = platform === "win32" ? "gi" : "g";
  const seen = new Set<string>();
  const patterns: RegExp[] = [];
  for (const root of roots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    for (const variant of [resolved.replace(/\//g, "\\"), resolved.replace(/\\/g, "/")]) {
      const key = platform === "win32" ? variant.toLowerCase() : variant;
      if (seen.has(key)) continue;
      seen.add(key);
      patterns.push(new RegExp(escapeRegExp(variant), flags));
    }
  }
  return patterns;
}

/** Absoliutūs keliai iš laisvo teksto. */
export function redactPaths(
  value: string,
  roots: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string {
  let redacted = value;
  for (const pattern of rootPatterns(roots, platform)) {
    redacted = redacted.replace(pattern, "<path>");
  }
  return redacted.replace(windowsPathPattern, "<path>").replace(posixPathPattern, "<path>");
}

/** Nuosavybės identifikatoriai. Patys savaime ne paslaptis, bet ir ne UI reikalas. */
export function redactIdentifiers(value: string): string {
  return value.replace(uuidPattern, "<id>");
}

export function sanitizeFreeText(
  value: string,
  roots: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string {
  return redactIdentifiers(redactPaths(value, roots, platform));
}
