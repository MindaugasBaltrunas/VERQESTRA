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
 *
 * Apkarpoma dalis NEDINGSTA: ji pridedama į `<filePath>.1` prieš perrašant originalą — 2026-08-28
 * „dirty tree" incidento įrodymai nukirsti prieš spėjus juos peržiūrėti, todėl rotacija turi
 * likti grįžtama. Vienas archyvo failas, ne grandinė: jis pats apkarpomas ta pačia riba.
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

  await archiveTrimmedLines(fs, `${filePath}.1`, lines.slice(0, lines.length - keepLines), maxLines, keepLines);

  await fs.writeTextFile(filePath, `${lines.slice(-keepLines).join("\n")}\n`);
  return lines.length;
}

async function archiveTrimmedLines(
  fs: HookFsPort,
  archivePath: string,
  trimmedLines: readonly string[],
  maxLines: number,
  keepLines: number,
): Promise<void> {
  if (trimmedLines.length === 0) return;

  await fs.appendTextFile(archivePath, `${trimmedLines.join("\n")}\n`);

  const archived = await fs.readTextFileIfExists(archivePath);
  if (!archived) return;
  const archivedLines = archived.split(/\r?\n/);
  const withoutTrailingBlank = archivedLines.at(-1) === "" ? archivedLines.slice(0, -1) : archivedLines;
  if (withoutTrailingBlank.length <= maxLines) return;

  await fs.writeTextFile(archivePath, `${withoutTrailingBlank.slice(-keepLines).join("\n")}\n`);
}
