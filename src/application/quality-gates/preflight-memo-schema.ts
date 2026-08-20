// Preflight kritimo memo schema (WBR E3: zod schemos gyvena prie savo modulio, ne core/schema).
//
// `vq/state/preflight-failure-memo/<task_id>.json` — paskutinio REALAUS preflight kritimo
// antspaudas. Kodėl atskiras store, o ne task ledger'is: `requeue` ledger'io įrašą TRINA,
// tad po requeue `taskSeenBefore` apie nepakitusį kritusį task'ą nieko nebežino ir tas pats
// turinys vėl gauna pilną preflight'ą. Šis memo yra vienintelis pėdsakas, kuris requeue
// išgyvena.
//
// Griežta (`.strict()`) sąmoningai: memo gali tik PARKUOTI task'ą, tad pavojinga kryptis yra
// KLAIDINGAS hit'as. Nežinomas `failure_class` ar nepažįstamas laukas privalo reikšti „įrašo
// nėra", o ne „įrašas galioja iš dalies" — validacijai kritus krentama į normalų preflight'ą,
// t. y. fail-open į BRANGESNĘ pusę.
import { z } from "zod";

export const PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION = 1;

/** Coarse taksonomija. NEPRIKLAUSO nuo LLM reason teksto — formuluočių jitter'is išjungtų guard'ą. */
export const preflightFailureClassSchema = z.enum(["preflight-exit"]);

export const preflightFailureMemoRecordSchema = z
  .object({
    schema_version: z.literal(PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION),
    task_id: z.string().min(1),
    /** `taskFingerprint` (git hash-object / sha256) reikšmė PRIEŠ preflight'ą. */
    content_hash: z.string().min(1),
    failure_class: preflightFailureClassSchema,
    /** Įrodymas, ne palyginimo raktas. */
    exit_code: z.number().int(),
    /** Paskutinio REALAUS preflight kritimo ISO ts; guard hit'as jo nekeičia. */
    failed_at: z.string().min(1),
    repeat_count: z.number().int().min(1),
  })
  .strict();

export type PreflightFailureMemoRecord = z.infer<typeof preflightFailureMemoRecordSchema>;
export type PreflightFailureClass = z.infer<typeof preflightFailureClassSchema>;
