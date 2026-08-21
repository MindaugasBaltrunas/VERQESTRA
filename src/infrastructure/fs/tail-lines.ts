// Failo UODEGOS skaitymas eilutėmis (etalonas: AG_loop ui log/įvykių skaitymo pusė).
//
// Kodėl uodega, o ne visas failas: `wave-events.jsonl` auga per visą loop'o gyvavimą, o UI rodo
// paskutinius įvykius. Perskaityti visą failą reikštų, kad dashboard'o atnaujinimas darosi vis
// brangesnis, kol galiausiai nustoja atsakinėti — būtent tada, kai loop'as dirba ilgiausiai.
//
// Du sprendimai, kurie yra kontraktas:
//   1. PIRMOJI lango eilutė ATMETAMA, kai langas prasideda ne nuo failo pradžios: baitų langas
//      beveik niekada nekrenta ties eilutės riba, tad pirmoji eilutė yra nukirsta. Nukirsta
//      JSONL eilutė nėra „sugadintas įvykis" — ji yra mūsų pjūvio artefaktas, ir jos rodymas
//      kaip gedimo meluotų apie duomenis.
//   2. Nesamas failas duoda TUŠČIĄ sąrašą, o katalogas ar kitas netinkamas šaltinis META:
//      „duomenų dar nėra" ir „šaltinis neperskaitomas" veda operatorių skirtingais keliais.

import { open, stat } from "node:fs/promises";

/** Numatytas langas: pakanka UI įvykių sąrašui, bet neauga kartu su failu. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * Paskutinės failo eilutės, skaitant ne daugiau kaip `maxBytes` nuo galo.
 *
 * Tuščios eilutės atmetamos: JSONL faile jos neneša įvykio, o UI sąraše virstų tuščiais tarpais.
 */
export async function readTailLines(absoluteFile: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<string[]> {
  let size: number;
  try {
    const info = await stat(absoluteFile);
    if (!info.isFile()) {
      throw new Error(`tail source is not a file: ${absoluteFile}`);
    }
    size = info.size;
  } catch (error: unknown) {
    // TIK nebuvimas yra tuščias sąrašas. Visa kita (teisės, katalogas, IO) keliauja aukštyn.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  if (size === 0) return [];
  const window = Math.min(size, Math.max(1, maxBytes));
  const start = size - window;

  const handle = await open(absoluteFile, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, start);
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }

  const lines = text.split(/\r?\n/);
  // Langas prasidėjo failo viduryje — pirmoji eilutė nukirsta ir nėra įvykis.
  if (start > 0) lines.shift();
  return lines.filter((line) => line.trim().length > 0);
}
