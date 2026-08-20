// Arrest markerio RAŠYMO pusė (etalonas: AG_loop policy/context-compression.ts
// observeContextCompressionArrest; VQ-305 policy note „context-compression rašymo pusė"
// likutis). Grynos taisyklės (recordContextCompressionArrestObservation) — domain/policies/
// compression/arrest; čia tik IO kompozicija per ContextPackFileSystemPort.
//
// Deep-import modulis kaip effective-compression-policy (ne barrel) — tie patys ciklo
// argumentai.

import {
  recordContextCompressionArrestObservation,
  type ContextCompressionArrest,
  type ContextCompressionArrestObservation,
} from "../../domain/policies/compression/arrest.js";

// Sankcionuoti interfaces → application → domain tiltai dispatch adapteriui (tas pats
// šablonas kaip preflight-fastpath): arrest žodynas ir canary kohortos taisyklė imami per
// šį modulį, ne tiesioginiu interfaces → domain importu.
export {
  CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH,
  defaultContextCompressionArrestState,
  describeContextCompressionArrest,
  selectCanaryHumanReviewTaskIds,
} from "../../domain/policies/compression/arrest.js";
export type { ContextCompressionConfig } from "../../domain/policies/compression/features.js";
import {
  contextCompressionArrestStatePath,
  readContextCompressionArrestState,
} from "./effective-compression-policy.js";
import type { ContextPackFileSystemPort } from "./ports.js";

/**
 * Užregistruoja vieną dispatch'ą arrest skaitikliuose ir persist'ina rezultatą.
 *
 * Best effort pagal konstrukciją: nepavykęs skaitymas, nepavykęs rašymas ir niekuo
 * nepasikeitusi būsena visi grąžina „naujų arrest'ų nėra", o ne meta — apskaita, galinti
 * nutraukti dispatch'ą, būtų didesnė avarija nei canary, kurį ji saugo. Neperskaitomas
 * markeris jau ir taip arrest'ina viską — jo perrašymas sunaikintų tai, ką operatorius
 * turi pamatyti.
 */
export async function observeContextCompressionArrest(
  fs: ContextPackFileSystemPort,
  runtimeRoot: string,
  observation: ContextCompressionArrestObservation,
): Promise<ContextCompressionArrest[]> {
  const view = await readContextCompressionArrestState(fs, runtimeRoot);
  if (view.unreadable) return [];

  const update = recordContextCompressionArrestObservation(view.state, observation);
  if (!update.changed) return [];
  try {
    // Port'o writeTextFile realiame adapteryje yra atominis (tmp + rename) — markerio
    // skaitytojai niekada nemato dalinio įrašo.
    await fs.writeTextFile(contextCompressionArrestStatePath(runtimeRoot), `${JSON.stringify(update.state, null, 2)}\n`);
  } catch {
    return [];
  }
  return update.arrested;
}
