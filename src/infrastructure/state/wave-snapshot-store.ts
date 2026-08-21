// Bangos snapshot'o SKAITYMAS (`vq/state/wave-snapshot.json`).
//
// Rašytojas gyvena loop wave planuotojuje ir dar nemigruotas; skaitytojas reikalingas jau dabar,
// nes UI bangų vaizdas be jo rodo tuščią planą kaip „viskas gerai".
//
// Skaitytojas TOLERANTIŠKAS sąmoningai: snapshot'as yra ATASKAITA apie planą, o ne pats planas.
// Sugadintas failas grąžina `undefined` — loop'ui tai reiškia „plano nežinome", ir UI tą parodo
// kaip degradavusį šaltinį. Griežtas parsinimas čia reikštų, kad viena bloga eilutė nuverčia
// visą dashboard'ą tuo metu, kai operatoriui jo labiausiai reikia.
//
// `exists` yra ATSKIRAS nuo skaitymo: be jo „atmetimų nėra" ir „snapshot'as neperskaitomas"
// susilietų į tą patį tuščią sąrašą.

import path from "node:path";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { tryParseJson } from "../../shared/json.js";

export function waveSnapshotPath(stateDir: string): string {
  return path.join(stateDir, "wave-snapshot.json");
}

/** Snapshot'as arba `undefined` (nėra ARBA neperskaitomas — skambintojas skiria per `exists`). */
export async function readWaveSnapshot<T extends object>(stateDir: string): Promise<T | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(waveSnapshotPath(stateDir));
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = tryParseJson<T>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? parsed.value
    : undefined;
}

export function waveSnapshotExists(stateDir: string): Promise<boolean> {
  return nodeFsAdapter.exists(waveSnapshotPath(stateDir));
}
