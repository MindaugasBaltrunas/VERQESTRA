// KOKIOS būsenos operatorius nori kiekvienam worker slot'ui (etalonas: AG_loop
// ui/loop-control-service.ts, task 0052).
//
// Modulis atsako TIK už norimos būsenos skaitymą ir rašymą — sprendimą „kiek slot'ų realiai
// išduoti" ir toliau priima worker pool'as su visais izoliacijos vartais. Valdiklis gali tik
// SUMAŽINTI: `run` nieko neišduoda, jis tik neatima.
//
// VERQESTRA nukrypimas nuo etalono: modulis gyvena application, ne ui sluoksnyje. Būseną skaito
// ne tik dashboard'as, bet ir pati banga prieš kiekvieną dispatch'ą, o VERQESTRA'oje būsenos
// saugyklos su fs portu jau gyvena čia (worker-lease-store, scope-lock-store) — UI lieka vienas
// iš skaitytojų, ne savininkas.
//
// Būsena gyvena `vq/state/loop-control.json`, o ne `vq/config/`: `vq/state` yra runtime prefiksas,
// tad UI įrašas nepalieka purvino produkto medžio ir švaraus medžio precondition neužblokuoja kito
// loop starto.
//
// Ką `abort` reiškia ČIA: tai NORIMA būsena, kuri neleidžia dispatch'inti naujo task'o ir yra
// raportuojama sąžiningai. Jis NENUTRAUKIA jau vykdomo bandymo — apsimesti, kad procesas
// nužudytas, būtų melas apie būseną. UI dėl to rodo „aborting", o ne „aborted".

import path from "node:path";
import { z } from "zod";
import { toPrettyJson } from "../../shared/json.js";
import type { SchedulingFileSystemPort } from "./ports.js";

export const LOOP_CONTROL_SCHEMA_VERSION = 1;

export const LOOP_SLOT_MODES = ["run", "drain", "abort"] as const;
export const loopSlotModeSchema = z.enum(LOOP_SLOT_MODES);
export type LoopSlotMode = z.infer<typeof loopSlotModeSchema>;

/**
 * Slot'ų raktai. LITERALAI sąmoningai: saugykla neturi importuoti pool'o limitų, o sutapimą su
 * runtime riba prikala testas.
 */
export const LOOP_SLOT_KEYS = ["w1", "w2"] as const;
export type LoopSlotKey = (typeof LOOP_SLOT_KEYS)[number];

const loopSlotKeySchema = z.enum(LOOP_SLOT_KEYS);

export const loopSlotControlSchema = z.strictObject({
  mode: loopSlotModeSchema,
  requested_at: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
});

export const loopControlSchema = z.strictObject({
  schema_version: z.literal(LOOP_CONTROL_SCHEMA_VERSION),
  updated_at: z.string().min(1),
  // `partialRecord`, ne `record`: trūkstamas slot'o įrašas yra GALIOJANTIS turinys — jis
  // reiškia „prašoma run", o ne sugadintą failą. Exhaustive `record` tokį failą atmestų ir
  // valdiklio būsena tyliai virstų `schema` gedimu.
  slots: z.partialRecord(loopSlotKeySchema, loopSlotControlSchema),
});

/**
 * Kūnas, kurį priima {@link setSlotMode}. `requested_at` sąmoningai NEPRIIMAMAS: laiko žymą stato
 * serveris, kitaip klientas galėtų persirašyti audito pėdsaką. `reason` apibrėžimas imamas iš
 * persistuojamos schemos, kad ilgio riba turėtų vieną vietą.
 */
const slotModeRequestSchema = z.strictObject({
  mode: loopSlotModeSchema,
  reason: loopSlotControlSchema.shape.reason,
});

export function loopControlFile(stateDir: string): string {
  return path.join(stateDir, "loop-control.json");
}

/**
 * Kodėl būsenos failas nepanaudotas. KODAS, o ne žinutė: reikšmė keliauja į dashboard'o atsakymą,
 * tad žalias fs/JSON tekstas ten paviešintų absoliučius kelius, o UI jo vis tiek nerodo.
 */
export type LoopControlProblem = "unreadable" | "malformed" | "schema";

export type LoopSlotControlState = {
  mode: LoopSlotMode;
  requested_at?: string | undefined;
  reason?: string | undefined;
};

export type LoopControlState = {
  /** VISI slot'ai visada užpildyti: „įrašo nėra" ir „prašoma `run`" yra ta pati būsena. */
  slots: Record<LoopSlotKey, LoopSlotControlState>;
  /** Užpildoma TIK kai failas yra, bet nepanaudojamas — kad UI galėtų parodyti, kodėl visi `run`. */
  invalid?: LoopControlProblem | undefined;
};

/** Prašymas, kurio priimti negalima (nežinomas slot'as arba netinkamas kūnas). */
export class InvalidLoopControlError extends Error {}

/**
 * Slot'o režimas pagal LAISVĄ `worker_id` eilutę (ji ateina iš pool'o plano, ne iš šio modulio).
 *
 * Nežinomas slot'as yra `run`: valdiklis gali tik sumažinti, tad id, apie kurį jis nieko nesako,
 * negali reikšti draudimo — kitaip būsimas trečias slot'as taptų tyliai užblokuotas.
 */
export function resolveSlotMode(control: LoopControlState, workerId: string): LoopSlotMode {
  const key = LOOP_SLOT_KEYS.find((candidate) => candidate === workerId);
  return key === undefined ? "run" : control.slots[key].mode;
}

function allSlots(mode: LoopSlotMode, requestedAt?: string): Record<LoopSlotKey, LoopSlotControlState> {
  const slots = {} as Record<LoopSlotKey, LoopSlotControlState>;
  for (const key of LOOP_SLOT_KEYS) {
    slots[key] = { mode, ...(requestedAt === undefined ? {} : { requested_at: requestedAt }) };
  }
  return slots;
}

export type LoopControlDeps = {
  fs: SchedulingFileSystemPort;
  now?: () => Date;
};

/**
 * Einamoji norima būsena. NIEKADA nemeta: kelias kviečiamas kiekvienos bangos pradžioje ir prieš
 * kiekvieną dispatch'ą, tad sugadintas ar dingęs failas privalo reikšti „visi slot'ai veikia", o ne
 * nutrūkusį loop'ą. Trūkstamas failas nėra klaida (`invalid` lieka tuščias); sugadintas — yra.
 *
 * Fail-soft kryptis pasirinkta sąmoningai `run` link: sugadintas failas negali TYLIAI sustabdyti
 * eilės, nes „loop'as nieko nedaro ir niekas nesako kodėl" yra blogesnė būsena už „valdiklis
 * neveikė".
 */
export async function readLoopControl(deps: LoopControlDeps, stateDir: string): Promise<LoopControlState> {
  const fallback: LoopControlState = { slots: allSlots("run") };

  let raw: string | undefined;
  try {
    raw = await deps.fs.readTextFileIfExists(loopControlFile(stateDir));
  } catch {
    // Neperskaitomas failas nėra numatytoji būsena: operatorius turi pamatyti, kodėl „stop"
    // neveikia.
    return { ...fallback, invalid: "unreadable" };
  }
  if (!raw?.trim()) return fallback;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ...fallback, invalid: "malformed" };
  }

  const result = loopControlSchema.safeParse(payload);
  if (!result.success) return { ...fallback, invalid: "schema" };

  const slots = allSlots("run");
  for (const key of LOOP_SLOT_KEYS) {
    const stored = result.data.slots[key];
    if (stored) slots[key] = stored;
  }
  return { slots };
}

/** Vienas rašymo kelias: katalogas + atominis įrašas + šviežias perskaitymas. */
async function writeLoopControl(
  deps: LoopControlDeps,
  stateDir: string,
  slots: Record<LoopSlotKey, LoopSlotControlState>,
): Promise<LoopControlState> {
  await deps.fs.makeDirectory(stateDir);
  await deps.fs.writeTextFileAtomic(
    loopControlFile(stateDir),
    toPrettyJson({
      schema_version: LOOP_CONTROL_SCHEMA_VERSION,
      updated_at: (deps.now?.() ?? new Date()).toISOString(),
      slots,
    }),
  );
  return await readLoopControl(deps, stateDir);
}

/**
 * Nustato VIENO slot'o norimą būseną.
 *
 * Tikrinami ABU įėjimai: ir slot'o raktas, ir VISAS užklausos kūnas. Kūnas paduodamas visas, o ne
 * išrenkamas laukas po lauko, nes tik taip `.strict()` realiai gina kontraktą: konstruojant naują
 * `{ mode }` objektą kliento papildomi laukai būtų tyliai numesti, o `null`, primityvai ir masyvai
 * net nepasiektų schemos — jie kristų ties lauko skaitymu ir virstų 500 klaida vartotojo įvesčiai.
 *
 * Netinkamas įėjimas META ir failo NEKEIČIA: kvietėjas turi grąžinti 400.
 */
export async function setSlotMode(
  deps: LoopControlDeps,
  stateDir: string,
  workerId: unknown,
  body: unknown,
): Promise<LoopControlState> {
  const slotKey = loopSlotKeySchema.safeParse(workerId);
  if (!slotKey.success) {
    throw new InvalidLoopControlError(`unknown worker slot: ${JSON.stringify(workerId)}`);
  }
  const parsed = slotModeRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidLoopControlError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const current = await readLoopControl(deps, stateDir);
  const slots = { ...current.slots };
  slots[slotKey.data] = {
    mode: parsed.data.mode,
    requested_at: (deps.now?.() ?? new Date()).toISOString(),
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
  };
  return await writeLoopControl(deps, stateDir, slots);
}

/**
 * Grąžina visus slot'us į `run`. Kviečiama loop starto metu: likusi `drain` vėliava priverstų ką tik
 * paleistą loop'ą atsisakyti pirmo task'o, o operatorius matytų „paleista", nors nieko nevyksta.
 */
export async function resetLoopControl(deps: LoopControlDeps, stateDir: string): Promise<LoopControlState> {
  return await writeLoopControl(deps, stateDir, allSlots("run", (deps.now?.() ?? new Date()).toISOString()));
}

/**
 * Visi slot'ai į `drain`. Kviečiama kartu su „stop": be to snapshot'as galėtų prieštarauti tikrovei
 * (loop'as stabdomas, o valdiklis vis dar rodytų `run`).
 */
export async function drainAllSlots(deps: LoopControlDeps, stateDir: string): Promise<LoopControlState> {
  return await writeLoopControl(deps, stateDir, allSlots("drain", (deps.now?.() ?? new Date()).toISOString()));
}
