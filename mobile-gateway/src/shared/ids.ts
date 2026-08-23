// Tapatybių generavimas. Etalone `randomUUID` buvo importuojamas TIESIAI į
// `domain/terminal-control-lease.ts`, o VERQESTRA sluoksnių taisyklė domene draudžia VISUS
// `node:` importus (žr. `docs/architecture.md` — „Kodėl `domain` neturi nė vieno `node:`
// importo"). `shared` juos turėti gali, ir būtent taip tą pačią problemą sprendžia šaknies
// paketas (`src/shared/hash.ts` → `node:crypto`).
//
// Kryptis nekeičia elgesio: tai tas pats `randomUUID`, tik pasiekiamas per sluoksnį, kuriam
// platformos žinojimas leistinas. Domenui lieka taisyklė, o ne šaltinis.
import { randomUUID } from "node:crypto";

/** Naujas lease identifikatorius (RFC 4122 v4). */
export function newLeaseId(): string {
  return randomUUID();
}

/** Naujas sesijos identifikatorius (RFC 4122 v4). */
export function newSessionId(): string {
  return randomUUID();
}
