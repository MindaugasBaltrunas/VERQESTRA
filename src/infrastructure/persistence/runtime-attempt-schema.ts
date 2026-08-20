// Runtime attempt manifesto schemos (etalono core/schema.ts runtime blokas — zod prie
// modulio; dizainas: runtime-artifacts kontraktas). Manifestas SĄMONINGAI neturi kintamo
// statuso lauko: vykdymo baigtis gyvena execution-result.json — statusas čia grąžintų
// mutable-singleton problemą, kuriai pašalinti artefaktas ir egzistuoja.

import { z } from "zod";
import { DEFAULT_MAX_RETRY_ATTEMPTS } from "../../domain/tasks/retry.js";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;

/** Aiški žyma „šis bandymas nebuvo planuotas iš grafo" `graph_hash` laukui. */
export const RUNTIME_GRAPH_HASH_NONE = "none";

const nonEmptyString = z.string().min(1);
const stringList = z.array(z.string());

export const runtimeAttemptPolicySchema = z.looseObject({
  selected_model: z.string().optional(),
  agent_chain: stringList.default([]),
  max_retries: z.number().int().nonnegative().default(DEFAULT_MAX_RETRY_ATTEMPTS),
  risk_level: z.string().optional(),
  requires_approval: z.boolean().default(false),
  budget_profile: z.string().optional(),
});

export const runtimeAttemptSourceSchema = z.looseObject({
  origin: z.enum(["queue-task", "repair-task", "architecture-node", "bootstrap", "manual"]),
  /** Task failo kelias projekto atžvilgiu (POSIX), jei toks failas yra. */
  task_file: z.string().optional(),
  /** `## Spec source` nuoroda — atsekamumas iki openspec pakeitimo. */
  spec_source: z.string().optional(),
  /** Bandymas, kurį šis taiso/tęsia. Pirmam bandymui tuščias. */
  parent_attempt_id: z.string().optional(),
  retry_key: z.string().optional(),
});

/**
 * `graph_hash` privalomas su aiškia `RUNTIME_GRAPH_HASH_NONE` reikšme, o ne optional:
 * koreliacinės užklausos niekada neturi skirti „nėra lauko" nuo „netaikoma". `wave_id`
 * optional (rankinis dispatch bangos neturi); `run_id`/`worker_id` — kelio segmentai.
 */
export const runtimeAttemptManifestSchema = z.looseObject({
  schema_version: z.number().int().positive().default(RUNTIME_MANIFEST_SCHEMA_VERSION),
  run_id: nonEmptyString,
  worker_id: nonEmptyString,
  task_id: nonEmptyString,
  attempt_id: nonEmptyString,
  attempt_sequence: z.number().int().positive().default(1),
  /** Yra tada, kai bandymas kilo iš suplanuotos bangos. */
  wave_id: z.string().optional(),
  /** `computeGraphHash` rezultatas arba `RUNTIME_GRAPH_HASH_NONE`. Niekada nėra tuščias. */
  graph_hash: nonEmptyString,
  policy: runtimeAttemptPolicySchema,
  source: runtimeAttemptSourceSchema,
  /** ISO laiko žyma, kurią paduoda kviečiantysis — saugykla laikrodžio neskaito. */
  created_at: nonEmptyString,
});

export type RuntimeAttemptManifest = z.infer<typeof runtimeAttemptManifestSchema>;
