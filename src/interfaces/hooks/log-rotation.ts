// Hook'ų žurnalų pagalbinės funkcijos (etalonas: AG_loop hooks/session-utils.ts).
//
// `latestStatus` skaito PASKUTINĘ atitinkančią eilutę, ne pirmą: žurnalas yra append-only, tad
// naujausias įrašas ir yra dabartinė būsena. Nė vienos atitikties nėra „praėjo" — tai
// „nepaleista / nežinoma", ir tas skirtumas svarbus: nepaleista patikra niekada neturi atrodyti
// žalia.

import type { HookFsPort } from "./protocol.js";

export type CheckStatus = "PASSED" | "FAILED" | "NOT RUN / UNKNOWN";

export function latestStatus(lines: readonly string[], passPattern: RegExp, failPattern: RegExp): CheckStatus {
  const latest = [...lines].reverse().find((line) => passPattern.test(line) || failPattern.test(line));
  if (latest && failPattern.test(latest)) return "FAILED";
  if (latest && passPattern.test(latest)) return "PASSED";
  return "NOT RUN / UNKNOWN";
}

/**
 * Apkarpo žurnalą, kai jis peraugo `maxLines`, paliekant paskutines `keepLines` eilutes.
 * Grąžina eilučių kiekį PRIEŠ apkarpymą (0 — failo nėra), kad kvietėjas galėtų raportuoti,
 * kiek buvo. Nesamas ar tuščias failas nėra klaida: rotacija yra higiena, ne vartai.
 */
export async function rotateFileByLines(
  fs: HookFsPort,
  filePath: string,
  maxLines: number,
  keepLines: number,
): Promise<number> {
  const content = await fs.readTextFileIfExists(filePath);
  if (!content) return 0;

  const lines = content.split(/\r?\n/);
  if (lines.length <= maxLines) return lines.length;

  await fs.writeTextFile(filePath, `${lines.slice(-keepLines).join("\n")}\n`);
  return lines.length;
}
