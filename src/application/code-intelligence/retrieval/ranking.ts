// Canonical retrieval ranking (spec ag-loop-optimization-v1, RAG-1; design §5).
// Behaviour etalon: AG_loop rag-lite/retrieval-extension.ts (AKTYVIOJI pusė —
// rankRetrievalCandidates + BM25; extension boundary/selectRetriever/policy loader —
// wont-migrate(disabled): 0 produkcinių importerių).
//
// "Produkcinis retrieval MUST prioritetizuoti direct spec reference, heading match,
// code/architecture evidence ir tik po to BM25-like dokumentų atitikimą."
//
// This is a pure policy function: candidates in, deterministically ordered candidates
// out. It performs no I/O, uses no clock and no randomness, so the same candidates and
// the same query always yield the same order — which is what makes a cached context
// pack reproducible.

// Highest priority first. A candidate is placed in the *strongest* tier it qualifies
// for; within a tier the BM25-like keyword score orders candidates, and equal scores
// keep their input order (the task's own `## Spec source` order).
export const RETRIEVAL_PRIORITY_ORDER = [
  "direct_spec_reference",
  "heading_match",
  "code_architecture_evidence",
  "bm25",
  "general_docs",
] as const;

export type RetrievalTier = (typeof RETRIEVAL_PRIORITY_ORDER)[number];

export type RetrievalCandidate = {
  // "path" or "path#heading", exactly as the task referenced it.
  ref: string;
  text: string;
  // True when the ref is listed in the task's `## Spec source` block.
  directSpecReference: boolean;
  // Set when the ref asked for `#heading`; `headingMatched` says whether that heading
  // section was actually found (false ⇒ the retriever fell back to the whole document).
  requestedHeading?: string;
  headingMatched?: boolean;
  // Repo-relative paths corroborating this candidate: the task's allowed paths, code
  // graph neighbours or architecture node sources.
  evidencePaths?: string[];
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
  // Evidence paths shared by every candidate (allowed paths, code-graph neighbours).
  evidencePaths?: string[];
};

// Standard BM25 saturation/length-normalization constants.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Scores are rounded before they are used as a sort key so that platform float noise can
// never reorder two otherwise equal candidates.
const SCORE_PRECISION = 6;

/**
 * Rank retrieval candidates by the canonical priority sequence.
 *
 * Tier assignment (strongest first):
 * 1. `direct_spec_reference` — the task names this document explicitly and asked for all
 *    of it (no `#heading` anchor).
 * 2. `heading_match` — the task named a `#heading` and that heading section was found.
 * 3. `code_architecture_evidence` — not named by the task, but the document is
 *    corroborated by code/architecture evidence (allowed paths, graph neighbours).
 * 4. `bm25` — no structural evidence, but the document matches the query lexically.
 * 5. `general_docs` — everything else. A named ref whose `#heading` was NOT found lands
 *    here on purpose: the retrieved text is the whole document, i.e. general context
 *    rather than the precise evidence the task asked for.
 */
export function rankRetrievalCandidates(
  candidates: RetrievalCandidate[],
  options: RetrievalRankingOptions,
): RankedRetrievalCandidate[] {
  const evidence = normalizeEvidencePaths(options.evidencePaths ?? []);
  const scores = bm25Scores(candidates.map((candidate) => `${candidate.ref}\n${candidate.text}`), options.query);

  return candidates
    .map((candidate, index) => {
      const keywordScore = scores[index] ?? 0;
      const candidateEvidence = new Set([...evidence, ...normalizeEvidencePaths(candidate.evidencePaths ?? [])]);
      const { tier, reason } = classifyRetrievalTier(candidate, candidateEvidence, keywordScore);
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

export function classifyRetrievalTier(
  candidate: RetrievalCandidate,
  evidencePaths: Set<string>,
  keywordScore: number,
): { tier: RetrievalTier; reason: string } {
  const requestedHeading = candidate.requestedHeading?.trim() ?? "";

  if (candidate.directSpecReference && !requestedHeading) {
    return { tier: "direct_spec_reference", reason: "direct `## Spec source` reference to the whole document" };
  }
  if (candidate.directSpecReference && requestedHeading && candidate.headingMatched === true) {
    return { tier: "heading_match", reason: `heading \`${requestedHeading}\` matched in the referenced document` };
  }
  if (candidate.directSpecReference && requestedHeading) {
    // Named ref, heading not found: the text is the whole document, so it is general
    // context, not the requested evidence — and it must lose to precise candidates.
    return { tier: "general_docs", reason: `heading \`${requestedHeading}\` not found; whole-document fallback` };
  }
  if (matchesEvidence(candidate.ref, evidencePaths)) {
    return { tier: "code_architecture_evidence", reason: "document is corroborated by code/architecture evidence" };
  }
  if (keywordScore > 0) {
    return { tier: "bm25", reason: `BM25-like keyword match (score ${keywordScore})` };
  }
  return { tier: "general_docs", reason: "general document without direct, structural or lexical evidence" };
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
      const documentFrequency = documentTerms.filter((other) => other.has(term)).length;
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3);
}

function roundScore(score: number): number {
  const factor = 10 ** SCORE_PRECISION;
  return Math.round(score * factor) / factor;
}

function normalizeEvidencePaths(paths: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const entry of paths) {
    const value = normalizePath(entry);
    if (value) {
      normalized.add(value);
    }
  }
  return normalized;
}

// NE `shared/paths.toComparablePosixPath` (task 0064): `trim` čia PIRMAS (tad `"  ./a"` → `"a"`,
// o bendras helper'is `^\.\/` nebeatpažintų) ir rezultatas yra `toLowerCase` — case-insensitive
// įrodymų atitiktis.
function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// A ref matches evidence when it points at the same file, allowing for the repo-relative
// vs. package-relative path forms that appear in tasks and in the code index.
function matchesEvidence(ref: string, evidencePaths: Set<string>): boolean {
  const hashIndex = ref.indexOf("#");
  const filePart = normalizePath(hashIndex === -1 ? ref : ref.slice(0, hashIndex));
  if (!filePart) {
    return false;
  }
  for (const evidence of evidencePaths) {
    if (evidence === filePart || evidence.endsWith(`/${filePart}`) || filePart.endsWith(`/${evidence}`)) {
      return true;
    }
  }
  return false;
}
