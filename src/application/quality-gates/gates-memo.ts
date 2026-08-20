// Kokybės vartų verdikto memoizacija — GRYNOJI pusė ir port'o kontraktas (etalono
// application/quality-gates/gates-memo.ts + core/schema gates-memo blokas; zod prie modulio,
// WBR VQ-305).
//
// Identiško darbo medžio pertikrinimas neduoda jokios informacijos: build + testų suite
// sukasi dešimtis kartų per dieną, dažnai ant to paties medžio. Todėl paskutinio ŽALIO
// paleidimo verdiktas įsimenamas kartu su pilna medžio tapatybe, ir kol ta tapatybė
// nepasikeitė, vartai praeina be suite. Raudonas verdiktas NIEKADA neįrašomas — memo gali
// tik pagreitinti jau įrodytą žalią, bet niekada nepaslėpti klaidos.
//
// Tapatybė (visos trys dalys, sujungtos į vieną `key`):
//   1. `tree`   — git worktree tree hash per LAIKINĄ indeksą (adapterio E4 darbas): `git add -A`
//                 + `git write-tree` duoda deterministinį viso medžio turinio hash'ą, ĮSKAITANT
//                 untracked produkto failus; gitignore'inti runtime keliai į jį nepatenka.
//   2. `dist`   — sukompiliuoto orchestratoriaus `dist` `.js` TURINIO hash'as. Būtent turinio,
//                 o ne buildstamp'o: stamp'ą kiekvienas build perrašo, tad juo raktintas memo
//                 nepataikytų niekada.
//   3. `config` — `vq/config/quality-policy.json` turinio hash'as: vartų komandų pakeitimas
//                 privalo anuliuoti memo, net jei konfigas gitignore'intas.
//
// Bet kuri abejonė (git nepasiekiamas, sugadintas įrašas, medis pajudėjo paleidimo metu)
// reiškia „memo nėra" — fail-open į BRANGESNĘ pusę, t. y. pilną suite.
//
// Realus FS/git port'as (`fsGatesMemoPort` etalone) — E4 adapteris; čia tik kontraktas ir
// grynos taisyklės, tad hit/miss/red/corrupted kelius galima įrodyti be realaus git repo.
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// Griežta (`.strict()`) sąmoningai: memo yra vienintelis kelias, kuriuo vartai gali praeiti
// NEPALEIDĘ suite, tad bet koks nepažįstamas ar trūkstamas laukas privalo reikšti „memo nėra",
// o ne „memo galioja iš dalies". Nežinomas laukas = kito (naujesnio ar sugadinto) formato
// įrašas, ir pasitikėti juo būtų fail-open į klaidingą žalią.
export const GATES_MEMO_SCHEMA_VERSION = 1;

export const gatesMemoRecordSchema = z
  .object({
    schema_version: z.literal(GATES_MEMO_SCHEMA_VERSION),
    /** Sudėtinis medžio tapatybės hash'as: `sha256(tree + dist + config + scope + commands)`. */
    key: z.string().min(1),
    /** Git worktree tree hash (įskaitant untracked produkto failus). */
    tree: z.string().min(1),
    /** Sukompiliuoto orchestratoriaus `dist` katalogo `.js` turinio hash'as; tuščias, kai dist nėra. */
    dist: z.string(),
    /** `vq/config/quality-policy.json` turinio hash'as; tuščias, kai konfigo nėra. */
    config: z.string(),
    scope: z.string().min(1),
    /** Realiai vykdytų vartų komandų sąrašas — memo galioja tik tam pačiam sąrašui. */
    commands: z.array(z.string().min(1)).min(1),
    passed_at: z.string().min(1),
  })
  .strict();

export type GatesMemoRecord = z.infer<typeof gatesMemoRecordSchema>;

/** Pilna vieno paleidimo medžio tapatybė; `key` yra visų dalių santrauka. */
export type GatesMemoIdentity = {
  readonly key: string;
  readonly tree: string;
  readonly dist: string;
  readonly config: string;
};

/**
 * Skaitymo baigtys yra TRYS, ne dvi: „nėra įrašo" ir „įrašas sugadintas" yra skirtingi
 * įvykiai. Abu veda į pilną suite, bet sugadintas įrašas privalo būti GARSUS — tylus
 * `return null` paslėptų tai, kad memo failas nuolat perrašomas šiukšlėmis.
 */
export type GatesMemoReadResult =
  | { readonly status: "hit"; readonly record: GatesMemoRecord }
  | { readonly status: "absent" }
  | { readonly status: "corrupted"; readonly errors: readonly string[] };

export type GatesMemoIdentityInput = {
  readonly projectRoot: string;
  readonly scope: string;
  readonly commands: readonly string[];
};

/**
 * Memo I/O port'as. Injektuojamas per `RunQualityGatesOptions.memoPort`; realų adapterį
 * (git tree hash per laikiną indeksą, dist turinio hash, atominis JSON įrašas) duoda E4.
 * `identify` grąžina `null`, kai tapatybės suskaičiuoti negalima (ne git repo, index.lock) —
 * tokiu atveju memo tiesiog nenaudojamas.
 */
export type GatesMemoPort = {
  identify(input: GatesMemoIdentityInput): Promise<GatesMemoIdentity | null>;
  read(projectRoot: string): Promise<GatesMemoReadResult>;
  write(projectRoot: string, record: GatesMemoRecord): Promise<void>;
  clear(projectRoot: string): Promise<void>;
};

/** `vq/state/quality-gates-memo.json` — memo įrašo kelias. */
export function gatesMemoPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "quality-gates-memo.json");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministinis raktas iš visų tapatybės dalių — vienoje eilutėje, stabilia tvarka. */
export function gatesMemoKey(parts: {
  tree: string;
  dist: string;
  config: string;
  scope: string;
  commands: readonly string[];
}): string {
  return sha256(
    JSON.stringify({
      v: GATES_MEMO_SCHEMA_VERSION,
      tree: parts.tree,
      dist: parts.dist,
      config: parts.config,
      scope: parts.scope,
      commands: [...parts.commands],
    }),
  );
}

/**
 * Ar memo įrašas dengia ŠĮ paleidimą. Raktas jau apima scope ir komandas, bet jos lyginamos
 * ir atskirai: raktas yra santrauka, o santraukos sutapimas be turinio sutapimo (nesvarbu,
 * kaip mažai tikėtinas) reikštų suite praleidimą kitoms komandoms.
 */
export function memoCovers(
  result: GatesMemoReadResult,
  identity: GatesMemoIdentity,
  scope: string,
  commands: readonly string[],
): boolean {
  if (result.status !== "hit") return false;
  const record = result.record;
  if (record.key !== identity.key || record.tree !== identity.tree) return false;
  if (record.dist !== identity.dist || record.config !== identity.config) return false;
  if (record.scope !== scope || record.commands.length !== commands.length) return false;
  return record.commands.every((command, index) => command === commands[index]);
}

/** Įrašo konstruktorius — vienas taškas, kuriame tapatybė virsta on-disk įrašu. */
export function gatesMemoRecordFor(
  identity: GatesMemoIdentity,
  scope: string,
  commands: readonly string[],
  passedAt: string,
): GatesMemoRecord {
  return {
    schema_version: GATES_MEMO_SCHEMA_VERSION,
    key: identity.key,
    tree: identity.tree,
    dist: identity.dist,
    config: identity.config,
    scope,
    commands: [...commands],
    passed_at: passedAt,
  };
}
