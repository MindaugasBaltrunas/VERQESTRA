// Retrieval reitingavimas. Behaviour etalon: AG_loop rag-lite/retrieval-extension.ts
// (aktyvioji pusė — rankRetrievalCandidates + BM25).
//
// This is a pure policy function: candidates in, deterministically ordered candidates
// out. It performs no I/O, uses no clock and no randomness, so the same candidates and
// the same query always yield the same order — which is what makes a cached context
// pack reproducible.
//
// ## NUKRYPIMAS: penkios pakopos sutrauktos į tris (auditas A3)
//
// Etalono `RAG-1` deklaravo penkias: direct spec reference → heading match →
// code/architecture evidence → BM25 → general docs. Dvi vidurinės produkcijoje buvo
// NEPASIEKIAMOS, ir ne dėl klaidos: joms reikia kandidatų, kurių task'as NEĮVARDIJO, o
// vienintelis toks gamintojas — `rag-lite/indexer.ts` discovery skeneris — etalone buvo
// negyvas (0 produkcinių kvietėjų) ir į VERQESTRA neperkeltas kaip `wont-migrate(dead)`.
// Likusios pakopos buvo apleistos funkcijos reitingavimo pusė.
//
// Jos ir NEBUVO reikalingos šiai sistemai: dokumentai, kuriuos discovery rastų, ateina
// kitais kanalais (CLAUDE.md automatiškai, README per readme-guard, politikos per config
// loaderius, kodo aplinka per `code_context` graph kanalą). Prie 12000 simbolių biudžeto
// spekuliatyvūs atitikmenys būtų ne pridėję konteksto, o išstūmę aiškiai įvardytą.
//
// BM25 lieka — bet kaip ANTRINIS rūšiavimo raktas pakopos viduje, ne kaip pakopa.
//
// Jei kada prireiks reitinguoti neįvardytus kandidatus (pvz. laisvos formos užduotims be
// `## Spec source`), tai projektuojama iš naujo kartu su savo biudžetu ir tokenizatoriumi —
// šitų pakopų prikelti nereikia.

// Highest priority first. A candidate is placed in the *strongest* tier it qualifies
// for; within a tier the BM25-like keyword score orders candidates, and equal scores
// keep their input order (the task's own `## Spec source` order).
export const RETRIEVAL_PRIORITY_ORDER = ["direct_spec_reference", "heading_match", "general_docs"] as const;

export type RetrievalTier = (typeof RETRIEVAL_PRIORITY_ORDER)[number];

/**
 * Kandidatas visada ateina iš task'o `## Spec source` bloko — kito gamintojo nėra, todėl
 * `directSpecReference` vėliavos nebėra: konstanta parametro drabužiais tik verstų kiekvieną
 * skaitytoją aiškintis, kada ji būna `false` (niekada).
 */
export type RetrievalCandidate = {
  // "path" or "path#heading", exactly as the task referenced it.
  ref: string;
  text: string;
  // Set when the ref asked for `#heading`; `headingMatched` says whether that heading
  // section was actually found (false ⇒ the retriever fell back to the whole document).
  requestedHeading?: string;
  headingMatched?: boolean;
};

export type RankedRetrievalCandidate = {
  // Position of the candidate in the input array — the caller maps the ranking back
  // onto its own richer fragment objects without this module knowing about them.
  index: number;
  ref: string;
  tier: RetrievalTier;
  tier_rank: number;
  keyword_score: number;
  reason: string;
};

export type RetrievalRankingOptions = {
  // Free text the BM25-like scorer ranks against — in production the task goal plus its
  // acceptance criteria.
  query: string;
};

// Standard BM25 saturation/length-normalization constants.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Scores are rounded before they are used as a sort key so that platform float noise can
// never reorder two otherwise equal candidates.
export const SCORE_PRECISION = 6;

/**
 * Rank retrieval candidates by the canonical priority sequence.
 *
 * Tier assignment (strongest first):
 * 1. `direct_spec_reference` — the task named this document and asked for all of it
 *    (no `#heading` anchor).
 * 2. `heading_match` — the task named a `#heading` and that heading section was found.
 * 3. `general_docs` — the task named a `#heading` that was NOT found, so the retrieved
 *    text is the whole document: general context rather than the precise evidence asked
 *    for, and it must lose to precise candidates.
 *
 * Within one tier the BM25-like keyword score decides, and equal scores keep input order.
 */
export function rankRetrievalCandidates(
  candidates: RetrievalCandidate[],
  options: RetrievalRankingOptions,
): RankedRetrievalCandidate[] {
  const scores = bm25Scores(candidates.map((candidate) => `${candidate.ref}\n${candidate.text}`), options.query);

  return candidates
    .map((candidate, index) => {
      const keywordScore = scores[index] ?? 0;
      const { tier, reason } = classifyRetrievalTier(candidate);
      return {
        index,
        ref: candidate.ref,
        tier,
        tier_rank: RETRIEVAL_PRIORITY_ORDER.indexOf(tier),
        keyword_score: keywordScore,
        reason,
      };
    })
    .sort((a, b) => a.tier_rank - b.tier_rank || b.keyword_score - a.keyword_score || a.index - b.index);
}

export function classifyRetrievalTier(candidate: RetrievalCandidate): { tier: RetrievalTier; reason: string } {
  const requestedHeading = candidate.requestedHeading?.trim() ?? "";

  if (!requestedHeading) {
    return { tier: "direct_spec_reference", reason: "direct `## Spec source` reference to the whole document" };
  }
  if (candidate.headingMatched === true) {
    return { tier: "heading_match", reason: `heading \`${requestedHeading}\` matched in the referenced document` };
  }
  // Named ref, heading not found: the text is the whole document, so it is general
  // context, not the requested evidence — and it must lose to precise candidates.
  return { tier: "general_docs", reason: `heading \`${requestedHeading}\` not found; whole-document fallback` };
}

/**
 * BM25-like relevance of each document against the query, over the candidate set as the
 * corpus. Pure and deterministic: no vector database, no embeddings, no external index.
 * An empty query or an empty corpus scores every document 0, which leaves the structural
 * tiers as the only ordering signal.
 */
export function bm25Scores(documents: string[], query: string): number[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (documents.length === 0 || queryTerms.length === 0) {
    return documents.map(() => 0);
  }

  const documentTerms = documents.map((document) => termFrequencies(tokenize(document)));
  const lengths = documentTerms.map((terms) => [...terms.values()].reduce((sum, count) => sum + count, 0));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const averageLength = totalLength === 0 ? 0 : totalLength / documents.length;

  // Dokumentų dažnis priklauso tik nuo korpuso, tad skaičiuojamas VIENĄ kartą. Anksčiau jis
  // buvo perskaičiuojamas termų ciklo viduje, skenuojant visus dokumentus kaskart — O(Q·D²)
  // vietoj O(Q·D). Rezultatas identiškas; svarbu tampa tik korpusui augant (auditas A5).
  const documentFrequencies = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequencies.set(term, documentTerms.filter((other) => other.has(term)).length);
  }

  return documentTerms.map((terms, index) => {
    if (averageLength === 0) {
      return 0;
    }
    let score = 0;
    for (const term of queryTerms) {
      const frequency = terms.get(term) ?? 0;
      if (frequency === 0) {
        continue;
      }
      const documentFrequency = documentFrequencies.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const normalization = 1 - BM25_B + (BM25_B * (lengths[index] ?? 0)) / averageLength;
      score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * normalization));
    }
    return roundScore(score);
  });
}

function termFrequencies(terms: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

/**
 * Skaidymas pagal UNICODE raides ir skaitmenis (2026-08-23, RAG auditas 3).
 *
 * Iki tol skirtukas buvo `[^a-z0-9_]`, tad kiekvienas ne ASCII žodis subyrėdavo į nieką: kirilicos
 * užklausa ir tiksliai ją atitinkantis dokumentas abu gaudavo 0, ir laimėdavo pirmas nesusijęs
 * kandidatas. Tai lietė ne tik kirilicą ar CJK — lietuviški `užduotis`, `įrodymas`, `sąrašas` irgi
 * skildavo į ASCII gabalus (`u`, `duotis`), tad net šio repo kalba veikė tik iš dalies.
 *
 * Trumpesni nei 3 simbolių termai metami ir stemming'o nėra (auditas A6). SĄMONINGAI paliekama: nuo
 * A3 sprendimo BM25 rūšiuoja tik PAKOPOS VIDUJE, tad jis lemia tvarką tarp lygiaverčių kandidatų, o
 * ne tai, kas apskritai patenka į pack'ą.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 3);
}

function roundScore(score: number): number {
  const factor = 10 ** SCORE_PRECISION;
  return Math.round(score * factor) / factor;
}
