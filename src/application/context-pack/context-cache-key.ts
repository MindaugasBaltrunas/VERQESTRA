// Context-cache rakto GRYNOJI pusė (spec RAG-2): šaltinių rūšiavimas ir fingerprint.
// Behaviour etalon: AG_loop orchestrator/runtime/context-cache.ts (computeContextCacheKey/
// sortSources/hashText). Pati saugykla (lookup/save/evict/capacity) — E4 per ContextCachePort;
// jos elgesio kontraktas aprašytas porto tipuose ports.ts.

import { createHash } from "node:crypto";
import { RETRIEVAL_PRIORITY_ORDER, SCORE_PRECISION } from "../code-intelligence/retrieval/ranking.js";
import { BOUNDARY_MIN_RATIO, CHANGE_DIR_FILES, MAX_SPEC_CANDIDATES } from "../code-intelligence/retrieval/spec-fragments.js";
import { IMPACTED_TEST_IMPORTER_DEPTH } from "../code-intelligence/query/query.js";
import { MIN_ARCHITECTURE_TOKEN_LENGTH } from "./assemble/gather.js";
import { MAX_SPEC_RETRIEVAL_WARNINGS, SPEC_DROP_REFS_LISTED, WARNING_SEVERITY } from "./assemble/spec-phase.js";
import { CONTEXT_CACHE_VERSION, type ContextCacheEntry, type ContextCacheSource, type ContextCacheSourceKind } from "./context-cache-model.js";

export const CONTEXT_CACHE_SOURCE_KINDS: readonly ContextCacheSourceKind[] = [
  "task",
  "source",
  "spec",
  "architecture",
  "policy",
];

export type ContextCacheKey = {
  fingerprint: string;
  components: Record<ContextCacheSourceKind, string>;
  sources: ContextCacheSource[];
};

export type ContextCacheLookup =
  | { status: "hit"; entry: ContextCacheEntry }
  | { status: "miss"; reason: "no_entry" | "invalid_entry" | "version_mismatch" | "source_drift" | "code_index_drift" };

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `WARNING_SEVERITY` → deterministinė eilutė.
 *
 * Raktai rūšiuojami pagal UTF-16 kodų vienetus (NE `localeCompare`: ta tvarka priklauso nuo ICU
 * lokalės, tad tas pats kodas skirtinguose procesuose duotų skirtingą raktą). Objekto savybių
 * įterpimo tvarka čia nenaudojama sąmoningai — raktas privalo būti baitas į baitą stabilus, o ne
 * stabilus „kol niekas nepertvarkė lentelės".
 */
function warningSeverityDescriptor(): string {
  return Object.entries(WARNING_SEVERITY)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, severity]) => `${name}=${severity}`)
    .join(",");
}

/**
 * Pack'ą formuojančių DERINIMO KONSTANTŲ atspaudas, dalyvaujantis rakte greta
 * `CONTEXT_CACHE_VERSION`. Pakeitus bet kurią iš jų, senas įrašas nustoja atitikti raktą
 * automatiškai — nereikia niekam prisiminti.
 *
 * DALINĖ apsauga, ir tai svarbu suprasti teisingai: ji pagauna tik konstantų derinimą.
 * GRYNAI LOGINIAI pakeitimai — antraščių sekcijų gilinimas, Markdown rūšies šaltinis, ribų
 * vartas — nekeičia nė vienos konstantos ir čia NEATSISPINDI. Jiems `CONTEXT_CACHE_VERSION`
 * kėlimas lieka vienintelis kontraktas, o `cache-key-contract` testas — priminimas.
 *
 * Įtraukiamos tik tos konstantos, kurios veikia SUKURTO pack'o turinį. Renderio konstantų
 * (`TRUST_BOUNDARY_RULE`, `RETRIEVED_DATA_TAG`) čia NĖRA sąmoningai: `execution-context.md`
 * generuojamas iš naujo kiekvieno hit'o metu, tad jų pakeitimai pasiekia ir senus įrašus.
 */
export const PACK_SEMANTICS_DESCRIPTOR = [
  `tiers:${RETRIEVAL_PRIORITY_ORDER.join(">")}`,
  `change_dir_files:${CHANGE_DIR_FILES.join(",")}`,
  `max_spec_candidates:${MAX_SPEC_CANDIDATES}`,
  `boundary_min_ratio:${BOUNDARY_MIN_RATIO}`,
  // Įspėjimų lubos veikia pack'o `spec_fragment_warnings` turinį (kirpimo eilutė + kiek
  // eilučių lieka), tad tai tokia pati derinimo konstanta kaip kandidatų lubos aukščiau.
  `max_spec_retrieval_warnings:${MAX_SPEC_RETRIEVAL_WARNINGS}`,
  // Importuotojų uždarinio gylis lemia, KIEK testų patenka į `impacted_tests` ir per juos į
  // `related_files`, t. y. tiesiogiai formuoja `code_context` (2026-08-24, RAG auditas 4).
  // Įvesta 2026-08-23 audite 3, bet deskriptoriuje pamiršta — o deskriptoriaus visa prasmė ta,
  // kad derinimo konstantos į raktą patektų BE atskiro prisiminimo. Spraga pačiame mechanizme,
  // kuris tokias spragas ir turi dengti.
  `impacted_test_importer_depth:${IMPACTED_TEST_IMPORTER_DEPTH}`,
  // Toliau — 2026-09-01 RAG audito 7 radiniai: ta pati klasė kaip pamirštas importuotojų gylis
  // aukščiau, tik keturi vienetai iš karto. Deskriptorius nėra sąrašas, kurį kas nors prižiūri
  // rankomis; kiekviena jame nesanti pack'ą formuojanti konstanta yra spraga PAČIAME mechanizme.

  // Trumpiausias architektūros mazgo žymuo lemia, KURIE mazgai atitinka taikinius
  // (`matchArchitectureNodes`), t. y. pack'o `code_context.architecture_nodes` turinį.
  `min_architecture_token_length:${MIN_ARCHITECTURE_TOKEN_LENGTH}`,
  // Kiek numestų ref'ų įvardijama vardais — tiesiogiai pack'o `spec_fragment_warnings` eilutės
  // tekstas, o kartu ir jai skirtas rezervas biudžete (`specSelectionDropWarning`).
  `spec_drop_refs_listed:${SPEC_DROP_REFS_LISTED}`,
  // Svarbos lentelė lemia lubų taikymo TVARKĄ (`capSpecRetrievalWarnings`), t. y. KURIOS
  // įspėjimų eilutės išgyvena. Serializuojama su kodų-vienetais rūšiuotais raktais: baitas į
  // baitą tas pats tarp procesų, ir nauja ar pervadinta svarba į raktą patenka savaime.
  `warning_severity:${warningSeverityDescriptor()}`,
  // Apvalinimas prieš rūšiavimą lemia, kurie kandidatai laikomi lygiaverčiais, tad ir jų tvarką
  // pakopos viduje (`rankRetrievalCandidates`) — o tvarka sprendžia, kas gauna biudžetą pirmas.
  `score_precision:${SCORE_PRECISION}`,
].join("|");

/**
 * Fingerprint a source set. Sources are ordered by kind (canonical priority order) and
 * then by path before hashing, so the caller's collection order cannot change the key.
 * Per-kind component digests make a drift attributable to task, source, spec,
 * architecture or policy without diffing the whole list.
 */
export function computeContextCacheKey(sources: ContextCacheSource[]): ContextCacheKey {
  const ordered = sortSources(sources);
  const components = {} as Record<ContextCacheSourceKind, string>;
  for (const kind of CONTEXT_CACHE_SOURCE_KINDS) {
    const forKind = ordered.filter((source) => source.kind === kind).map((source) => `${source.path}:${source.hash}`);
    components[kind] = hashText(JSON.stringify(forKind));
  }

  const fingerprint = hashText(
    JSON.stringify({
      version: CONTEXT_CACHE_VERSION,
      semantics: hashText(PACK_SEMANTICS_DESCRIPTOR),
      components: CONTEXT_CACHE_SOURCE_KINDS.map((kind) => [kind, components[kind]]),
    }),
  );

  return { fingerprint, components, sources: ordered };
}

/** Kanoninis šaltinių rūšiavimas — jį naudoja ir raktas, ir E4 saugyklos drift patikra. */
export function sortSources(sources: ContextCacheSource[]): ContextCacheSource[] {
  return [...sources]
    .map((source) => ({ kind: source.kind, path: normalizeRelative(source.path), hash: source.hash }))
    .sort(
      (a, b) =>
        CONTEXT_CACHE_SOURCE_KINDS.indexOf(a.kind) - CONTEXT_CACHE_SOURCE_KINDS.indexOf(b.kind) ||
        a.path.localeCompare(b.path) ||
        a.hash.localeCompare(b.hash),
    );
}

export function normalizeRelative(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

// `--with-code-graph` renka kandidatus per skirtingą kelią nei numatytas (auto) režimas
// (`gatherCodeContextCandidates` vs `autoGatherCodeContextCandidates` assemble.ts faile), tad
// pack'o `code_context` skiriasi TIEMS PATIEMS taikiniams. Be šio šaltinio abu režimai suktų į
// tą patį fingerprint'ą, ir vienas režimas užrašytą įrašą grąžintų kitam kaip svetimą hit'ą.
// Sintetinis šaltinis, pagal `contextCompressionArrestCacheSource` pavyzdį
// (`compression-cache-sources.ts`): ne failo baitai, o iš režimo išvestas derived hash.
export function codeGraphModeCacheSource(withCodeGraph: boolean): ContextCacheSource {
  const mode = withCodeGraph ? "with-code-graph" : "auto";
  return {
    kind: "policy",
    path: "context-pack/with-code-graph",
    hash: createHash("sha256").update(mode, "utf8").digest("hex"),
  };
}
