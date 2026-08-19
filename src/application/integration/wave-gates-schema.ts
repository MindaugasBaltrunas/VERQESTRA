// Bangos vartų ir integracijos enforcement schemos (zod prie modulio — E3 taisyklė).
// Behaviour etalon: AG_loop core/schema.ts wave-gate blokas (1:1; laukų tvarka ir
// default'ai — baitinis kontraktas persistuojamam raportui).
//
// Vardai yra UŽDARA aibė, o ne laisvas tekstas: „vartas nepaleistas" privalo skirtis nuo
// „vartas nesukonfigūruotas" ir nuo „tokio varto iš viso nėra". Tik uždara aibė leidžia
// `run-wave-gates.ts` deterministiškai pasakyti, KURIO privalomo varto trūksta. Tvarka
// reikšminga: ji yra vykdymo tvarka, nuo pigiausio iki brangiausio.

import { z } from "zod";

const nonEmptyString = z.string().min(1);
const stringList = z.array(z.string());

export const WAVE_GATE_NAMES = [
  "typecheck",
  "lint",
  "architecture",
  "contract-compatibility",
  "integration-tests",
  "build",
] as const;
export type WaveGateName = (typeof WAVE_GATE_NAMES)[number];
export const waveGateNameSchema = z.enum(WAVE_GATE_NAMES);

/**
 * Vartai, kuriuos vykdo IŠORINĖ komanda. `contract-compatibility` čia sąmoningai nėra:
 * jis skaičiuojamas iš contract diff rezultato. Išorinė komanda reikštų, kad kontraktų
 * suderinamumo verdiktas priklauso nuo target projekto konfigūracijos — o jis privalo
 * būti orkestratoriaus savybė, kurios projektas negali išjungti jos nesukonfigūravęs.
 */
export const WAVE_COMMAND_GATE_NAMES = [
  "typecheck",
  "lint",
  "architecture",
  "integration-tests",
  "build",
] as const;
export type WaveCommandGateName = (typeof WAVE_COMMAND_GATE_NAMES)[number];

/**
 * Bangos varto komanda visada yra spawn formos (`cmd` + `args`), niekada shell string:
 * bangos vartai paleidžiami be žmogaus priežiūros, tad shell interpoliacijos paviršiaus
 * čia neturi būti. Komandos vis tiek praeina komandų politikos vartus — schema garantuoja
 * tik formą, ne saugumą.
 */
export const waveGateCommandSchema = z
  .object({ cmd: nonEmptyString, args: stringList.default([]) })
  .passthrough();

/**
 * Kiekvienas komandinis vartas OPTIONAL, nes „nesukonfigūruota" yra tikra, atskirai
 * raportuojama būsena (`missing`), o ne klaida konfigūracijos skaitymo metu. Numatytųjų
 * komandų čia NĖRA: atspėta komanda, kuri tyliai nieko nepatikrina, yra blogiau nei
 * aiškiai trūkstamas vartas.
 */
export const waveGatePolicySchema = z
  .object({
    typecheck: waveGateCommandSchema.optional(),
    lint: waveGateCommandSchema.optional(),
    architecture: waveGateCommandSchema.optional(),
    "integration-tests": waveGateCommandSchema.optional(),
    build: waveGateCommandSchema.optional(),
  })
  .passthrough();
export type WaveGatePolicy = z.infer<typeof waveGatePolicySchema>;

export const WAVE_GATE_REPORT_SCHEMA_VERSION = 1;

/** Sentinelė „vartas neturėjo exit code, nes komanda nebuvo paleista". */
export const WAVE_GATE_NOT_RUN_EXIT_CODE = -1;
/** Politikos užblokuotos komandos exit code — ta pati reikšmė kaip task vartuose. */
export const WAVE_GATE_BLOCKED_EXIT_CODE = 126;

/**
 * `missing` = vartas nesukonfigūruotas; `blocked` = komanda atmesta command policy;
 * `skipped` = ankstesnis vartas jau lūžo, todėl brangesnis vartas nebuvo paleistas.
 * Visi trys yra NE-praėjimai: nė vienas iš jų neleidžia bangos priimti.
 */
export const waveGateStatusSchema = z.enum(["passed", "failed", "missing", "blocked", "skipped"]);
export type WaveGateStatus = z.infer<typeof waveGateStatusSchema>;

export const waveGateResultSchema = z
  .object({
    gate: waveGateNameSchema,
    status: waveGateStatusSchema,
    /** Vykdyta komanda arba tuščia, kai varto komandos nėra (`missing`/vidinis vartas). */
    command: z.string().default(""),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    detail: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();
export type WaveGateResult = z.infer<typeof waveGateResultSchema>;

/**
 * Persistuojamas bangos vartų įrodymas. `source_hash` pririša rezultatą prie KONKREČIOS
 * kodo būsenos (branch + head + contract diff), todėl senas raportas niekada negali būti
 * palaikytas šviežiu vien todėl, kad sutampa `wave_id`.
 */
export const waveGateReportSchema = z
  .object({
    schema_version: z.number().int().positive().default(WAVE_GATE_REPORT_SCHEMA_VERSION),
    run_id: nonEmptyString,
    wave_id: nonEmptyString,
    branch: nonEmptyString,
    head: z.string().default(""),
    source_hash: nonEmptyString,
    contract_diff_hash: z.string().default(""),
    ok: z.boolean(),
    gates: z.array(waveGateResultSchema).default([]),
    selected_tests: stringList.default([]),
    blocking_reasons: stringList.default([]),
    started_at: nonEmptyString,
    finished_at: nonEmptyString,
    duration_ms: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type WaveGateReport = z.infer<typeof waveGateReportSchema>;

/**
 * Integracijos rizikos vartų vykdymo režimas (spec IVER-3).
 *
 * `advisory` — verdiktas apskaičiuojamas ir registruojamas, bet task'o eiga NEKEIČIAMA.
 * `enforce`  — galioja fail-safe semantika: `review-required` be semantinio reviewer'io
 *              parkuojamas į human-review, o ne tyliai patvirtinamas.
 *
 * Numatytoji reikšmė yra `advisory`, nes vartų ĮJUNGIMAS yra operatoriaus sprendimas.
 * Nežinoma reikšmė NĖRA tyliai nuleidžiama į `advisory` — `z.enum` ją paverčia konfigo
 * klaida (klaidingai užrašytas `enfore` privalo skambėti, o ne tyliai išjungti vartus).
 */
export const INTEGRATION_ENFORCEMENT_MODES = ["advisory", "enforce"] as const;
export const integrationEnforcementModeSchema = z.enum(INTEGRATION_ENFORCEMENT_MODES);
export type IntegrationEnforcementMode = z.infer<typeof integrationEnforcementModeSchema>;

export const integrationVerifierPolicySchema = z
  .object({ mode: integrationEnforcementModeSchema.default("advisory") })
  .passthrough();
export type IntegrationVerifierPolicy = z.infer<typeof integrationVerifierPolicySchema>;
