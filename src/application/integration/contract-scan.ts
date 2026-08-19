// Bendri teksto skenavimo įrankiai kontraktų ekstrakcijai. Behaviour etalon: AG_loop
// application/integration/contract-diff.ts skenavimo blokas (etalono 937 eil. failas
// skaidomas į scan/extract/diff pagal 500 eil. gate; taisyklės 1:1).
//
// Analizė yra FORMOS, ne semantikos: taisyklės remiasi deklaracijų forma, nes tik tokia
// analizė yra atkuriama. Žinomos ribos dokumentuojamos sąmoningai: skeneris nesupranta
// preprocesoriaus, makrokomandų, string literaluose paslėptų skliaustų ir tipų inference.

import type { ContractDescriptor } from "./contract-model.js";

export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Pašalina komentarus ir suveda tarpus — kad formatavimas nevirstų kontrakto pokyčiu. */
export function normalizeSignature(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([,;:<>()[\]{}])\s*/g, "$1")
    .trim()
    .replace(/[=,;{]+$/, "")
    .trim();
}

/**
 * Skenuoja nuo regiono pradžios iki pirmo `stops` simbolio, esančio NULINIAME skliaustų
 * gylyje. Skliaustai string literaluose neatpažįstami — dokumentuota riba.
 */
export function scanHeader(region: string, stops: string): { header: string; index: number; stop: string } {
  let depth = 0;
  for (let i = 0; i < region.length; i += 1) {
    const ch = region[i] as string;
    if (depth === 0 && stops.includes(ch)) {
      return { header: region.slice(0, i), index: i, stop: ch };
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
  }
  return { header: region, index: region.length, stop: "" };
}

/** Subalansuoto bloko turinys (be paties skliausto) arba `undefined`, jei bloko nėra. */
export function balancedBlock(region: string, from: number, open: "{" | "("): string | undefined {
  const close = open === "{" ? "}" : ")";
  const start = region.indexOf(open, from);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < region.length; i += 1) {
    const ch = region[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return region.slice(start + 1, i);
    }
  }
  return undefined;
}

/** Bloko segmentai NULINIAME gylyje: įdėtų objektų vidus lieka savo segmento viduje. */
export function topLevelSegments(block: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of block) {
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && (ch === ";" || ch === "," || ch === "\n")) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

const MEMBER_NAME =
  /^(?:readonly\s+|static\s+|public\s+|private\s+|protected\s+|abstract\s+|declare\s+|async\s+|get\s+|set\s+|\*\s*)*\[?\s*["']?([A-Za-z_$][\w$]*)["']?/;

/** Narių vardai iš deklaracijų bloko (interface/type/class/enum kūnas, parametrų sąrašas). */
export function memberNames(block: string | undefined): string[] {
  if (!block) return [];
  const names: string[] = [];
  for (const segment of topLevelSegments(block)) {
    if (segment.startsWith("//") || segment.startsWith("/*") || segment.startsWith("...")) continue;
    const match = MEMBER_NAME.exec(segment);
    if (match?.[1]) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

/**
 * Perkrauti (overload) parašai ir pasikartojantys maršrutai gauna `#2`, `#3` … priesagas,
 * kad du skirtingi kontraktai niekada nesusilietų į vieną ir vienas jų nedingtų iš diff'o.
 */
export function dedupeById(descriptors: ContractDescriptor[]): ContractDescriptor[] {
  const seen = new Map<string, number>();
  return descriptors.map((descriptor) => {
    const count = (seen.get(descriptor.id) ?? 0) + 1;
    seen.set(descriptor.id, count);
    return count === 1 ? descriptor : { ...descriptor, id: `${descriptor.id}#${count}` };
  });
}
