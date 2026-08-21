// Bangos snapshot'o SKAITYMAS ir RAŠYMAS (`vq/state/wave-snapshot.json`).
//
// Skaitytojas TOLERANTIŠKAS sąmoningai: snapshot'as yra ATASKAITA apie planą, o ne pats planas.
// Sugadintas failas grąžina `undefined` — loop'ui tai reiškia „plano nežinome", ir UI tą parodo
// kaip degradavusį šaltinį. Griežtas parsinimas čia reikštų, kad viena bloga eilutė nuverčia
// visą dashboard'ą tuo metu, kai operatoriui jo labiausiai reikia.
//
// `exists` yra ATSKIRAS nuo skaitymo: be jo „atmetimų nėra" ir „snapshot'as neperskaitomas"
// susilietų į tą patį tuščią sąrašą.

import path from "node:path";
import { waveSnapshotSchema, type WaveSnapshot } from "../../application/scheduling/wave-snapshot.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";

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

/**
 * Atominis snapshot'o rašymas su schemos patikra PRIEŠ rašymą.
 *
 * Patikra čia nėra formalumas: snapshot'as su `max_workers > 2` arba be `graph_hash` yra
 * PROGRAMAVIMO klaida planuotojuje, ir ją reikia pamatyti iš karto, o ne po kito kritimo, kai
 * loop'as jau bus pastatęs sprendimus ant negaliojančio įrašo.
 *
 * Rašymas atominis, nes snapshot'ą lygiagrečiai skaito UI: pusiau įrašytas failas ten virstų
 * „plano nėra", ir dashboard'as parodytų tuščią bangą tarp dviejų teisingų kadrų.
 */
export async function writeWaveSnapshot(stateDir: string, snapshot: WaveSnapshot): Promise<WaveSnapshot> {
  const validated = waveSnapshotSchema.parse(snapshot);
  await nodeFsAdapter.makeDirectory(stateDir);
  await nodeFsAdapter.writeTextFileAtomic(waveSnapshotPath(stateDir), toPrettyJson(validated));
  return validated;
}
