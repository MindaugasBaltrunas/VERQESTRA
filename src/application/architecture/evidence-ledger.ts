// Evidence ledger'io IO (etalonas: AG_loop architecture/architecture-evidence.ts, WBR
// VQ-501 3/5-c): JSONL append/read per portą. Tipai — domain/architecture/evidence
// (re-eksportuojami etalono API paritetu). Nesamas failas skaitant — tuščias sąrašas.

import type { EvidenceEntry, UnknownEntry } from "../../domain/architecture/evidence.js";
import type { ArchitectureStateFsPort } from "./ports.js";

export type { EvidenceEntry, UnknownEntry } from "../../domain/architecture/evidence.js";

export async function appendEvidence(
  fs: ArchitectureStateFsPort,
  ledgerPath: string,
  entry: EvidenceEntry,
): Promise<void> {
  await fs.appendTextFile(ledgerPath, `${JSON.stringify(entry)}\n`);
}

/** JSONL skaitymo rezultatas: perskaityti įrašai ir praleistų (sugadintų) eilučių skaičius. */
export type JsonlReadResult<T> = {
  entries: T[];
  /** Eilutės, kurių `JSON.parse` nepriėmė — praleistos, ne mestos (žr. parseJsonlLines). */
  skipped: number;
};

/**
 * JSONL eilutės į įrašus, sugadintas praleidžiant. Append-only žurnalas gali turėti nutrūkusią
 * eilutę (nutrauktas rašymas, disko klaida); iki 2026-09-05 viena tokia eilutė `JSON.parse`
 * išimtimi nuversdavo VISĄ wave/queue-synth bangą, nors likę įrodymai buvo tvarkingi. Elgesys
 * suvienodintas su token-usage skaitytojais: bloga eilutė praleidžiama IR suskaičiuojama, kad
 * „nėra įrodymų" niekada nemeluotų apie sugadintą žurnalą.
 */
function parseJsonlLines<T>(raw: string | undefined): JsonlReadResult<T> {
  if (raw === undefined) return { entries: [], skipped: 0 };
  const entries: T[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/** Evidence žurnalas KARTU su sugadintų eilučių skaitikliu (kvietėjas jį parodo priežastyje). */
export async function readEvidenceLedgerWithSkipped(
  fs: ArchitectureStateFsPort,
  ledgerPath: string,
): Promise<JsonlReadResult<EvidenceEntry>> {
  return parseJsonlLines<EvidenceEntry>(await fs.readTextFileIfExists(ledgerPath));
}

export async function readEvidenceLedger(fs: ArchitectureStateFsPort, ledgerPath: string): Promise<EvidenceEntry[]> {
  return (await readEvidenceLedgerWithSkipped(fs, ledgerPath)).entries;
}

export async function appendUnknown(
  fs: ArchitectureStateFsPort,
  unknownsPath: string,
  entry: UnknownEntry,
): Promise<void> {
  await fs.appendTextFile(unknownsPath, `${JSON.stringify(entry)}\n`);
}

export async function readUnknowns(fs: ArchitectureStateFsPort, unknownsPath: string): Promise<UnknownEntry[]> {
  // Ta pati atsparumo taisyklė kaip evidence žurnale — sugadinta eilutė nenuverčia skaitymo.
  return parseJsonlLines<UnknownEntry>(await fs.readTextFileIfExists(unknownsPath)).entries;
}
