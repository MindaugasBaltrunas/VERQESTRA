// Code-index saugojimo BYTE kontraktas — grynos serializacijos taisyklės (WBR VQ-301):
// JSONL be \r, su trailing \n, įrašo raktų tvarka = objekto konstravimo tvarka;
// manifest.json — pretty JSON (2 tarpai) su trailing \n. E4 adapteris rašo TIK šias
// eilutes — kontrakto savininkas yra šis modulis, ne fs sluoksnis. Behaviour etalon:
// AG_loop code-index/store.ts writeJsonl + core/fs.writeJsonAtomic.

import { toPrettyJson } from "../../../shared/json.js";

/** Vienas JSONL blokas: kiekviena reikšmė — atskira eilutė, failas baigiasi \n. */
export function renderJsonl(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

/** Griežtas JSONL skaitymas: tuščios eilutės praleidžiamos, kiekviena kita — JSON.parse. */
export function parseJsonl<T>(raw: string): T[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** manifest.json baitinė forma. */
export function renderManifestJson(manifest: unknown): string {
  return toPrettyJson(manifest);
}
