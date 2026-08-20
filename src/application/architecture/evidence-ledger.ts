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

export async function readEvidenceLedger(fs: ArchitectureStateFsPort, ledgerPath: string): Promise<EvidenceEntry[]> {
  const raw = await fs.readTextFileIfExists(ledgerPath);
  if (raw === undefined) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvidenceEntry);
}

export async function appendUnknown(
  fs: ArchitectureStateFsPort,
  unknownsPath: string,
  entry: UnknownEntry,
): Promise<void> {
  await fs.appendTextFile(unknownsPath, `${JSON.stringify(entry)}\n`);
}

export async function readUnknowns(fs: ArchitectureStateFsPort, unknownsPath: string): Promise<UnknownEntry[]> {
  const raw = await fs.readTextFileIfExists(unknownsPath);
  if (raw === undefined) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as UnknownEntry);
}
