// Retrieval reitingavimo politika — GRYNA funkcija, be I/O. Atskirai nuo
// code-intelligence.test.ts, kur gyvena fragmentų paėmimas (failų skaitymas, antraščių
// sekcijos, biudžetas): tai dvi skirtingos temos, ir pirmoji per RAG auditą išaugo tiek,
// kad bendras failas priartėjo prie 500 eilučių ribos.

import assert from "node:assert/strict";
import test from "node:test";
import { rankRetrievalCandidates } from "../application/code-intelligence/retrieval/ranking.js";

// Trys pakopos, ne penkios (auditas A3). Visi kandidatai ateina iš `## Spec source` — kito
// gamintojo nėra — tad pakopą lemia TIK tai, ar prašyta antraštė ir ar ji rasta. BM25 lieka
// antriniu raktu PAKOPOS VIDUJE: žemiau du `direct_spec_reference` kandidatai rikiuojami
// būtent balu, o ne įvesties tvarka.
test("retrieval ranking: trys pakopos, heading fallback nuleistas, BM25 rikiuoja pakopos viduje", () => {
  const ranked = rankRetrievalCandidates(
    [
      { ref: "doc/miss.md#nerasta", text: "visas dokumentas", requestedHeading: "nerasta", headingMatched: false },
      { ref: "doc/tolimas.md", text: "visai kitas tekstas" },
      { ref: "doc/artimas.md", text: "užklausos žodis budget planas" },
      { ref: "doc/hit.md#rasta", text: "sekcija", requestedHeading: "rasta", headingMatched: true },
    ],
    { query: "budget planas" },
  );

  assert.deepEqual(
    ranked.map((entry) => entry.tier),
    ["direct_spec_reference", "direct_spec_reference", "heading_match", "general_docs"],
  );
  assert.deepEqual(
    ranked.map((entry) => entry.ref),
    ["doc/artimas.md", "doc/tolimas.md", "doc/hit.md#rasta", "doc/miss.md#nerasta"],
    "pakopos viduje laimi didesnis BM25 balas, o nerasta antraštė nukrenta į general_docs",
  );
  assert.ok((ranked[0]?.keyword_score ?? 0) > 0, "BM25 tebeveikia kaip rūšiavimo raktas");
  assert.equal(ranked[1]?.keyword_score, 0);
});

// Lygūs balai laiko įvesties tvarką — tai ir daro kešuojamą pack'ą atkuriamą.
test("retrieval ranking: lygios poros laiko įvesties tvarką", () => {
  const ranked = rankRetrievalCandidates(
    [
      { ref: "doc/b.md", text: "nesusijęs" },
      { ref: "doc/a.md", text: "taip pat nesusijęs" },
    ],
    { query: "visai kitkas" },
  );
  assert.deepEqual(ranked.map((entry) => entry.ref), ["doc/b.md", "doc/a.md"]);
});
