// Spec fragmentų fazė: nuo task'o `## Spec source` ref'ų iki to, kas realiai patenka į pack'ą.
// Iškelta iš `assemble`, kai ta funkcija peržengė 500 eilučių gate — ir riba čia sutampa su
// atsakomybe: visa spec logika (paėmimas, reitingavimas, biudžetas, pranešimai) yra viena tema.
//
// ## Kodėl DVI fazės su reitingavimu viduryje (auditas A1)
//
// Anksčiau paėmimas ir biudžetas buvo tas pats ciklas: ref'ai eidavo surašymo tvarka, o išsekęs
// biudžetas nutraukdavo likusius. Reitingavimas bėgdavo PO to, tad galėdavo tik perrikiuoti
// išgyvenusius. Prie `max_context_chars: 12000` vienas pirmas viso dokumento ref'as suvalgydavo
// biudžetą, o trečias sąraše `spec.md#antraštė` — stipriausia pakopa — nebūdavo net perskaitytas.
// Dabar: paimami VISI kandidatai, jie sureitinguojami, ir tik tada leidžiamas biudžetas.

import {
  applySpecFragmentBudget,
  MAX_SPEC_CANDIDATES,
  retrieveSpecFragmentCandidates,
  type RetrievedFragment,
} from "../../code-intelligence/retrieval/spec-fragments.js";
import { rankRetrievalCandidates } from "../../code-intelligence/retrieval/ranking.js";
import type { CodeIntelligenceFileSystemPort } from "../../code-intelligence/ports.js";
import { SPEC_HEADING_MISS_WARNING } from "../context-pack-schema.js";
import { retrievalQuery, toRetrievalCandidate, type ParsedContextPackTask } from "./parse-task.js";

/**
 * Kiek paėmimo įspėjimų telpa į pack'ą prieš tai, kad jie patys pradėtų kainuoti kontekstą.
 * Įspėjimai guli PAČIAME pack'e, o pack'as privalo tilpti į `max_context_chars`; sugadintas
 * task'as gali pagaminti dešimtis, ir diagnostika neturi teisės sugriauti to, ką diagnozuoja.
 */
export const MAX_SPEC_RETRIEVAL_WARNINGS = 10;

export type SpecPhaseResult = {
  /**
   * Fragmentai, patekę į pack'ą, reitinguota tvarka. Kirpimo būsena keliauja ANT pačių
   * fragmentų (`fragment.truncated`) — atskiro sąrašo čia sąmoningai nėra, nes assemble
   * `spec_fragment_truncated` išveda iš fragmentų, likusių PO graph-selection, o fazės
   * momentu to sąrašo dar negalima žinoti. Du to paties fakto šaltiniai išsiskirtų.
   */
  kept: RetrievedFragment[];
  /** Žmogui skirtos eilutės `spec_fragment_warnings` laukui (su lubomis). */
  warnings: string[];
  /** Metrikai: PRARASTŲ ref'ų skaičius, ne įspėjimų eilučių (tos turi lubas). */
  droppedCount: number;
};

export type SpecPhaseInput = {
  codeFs: CodeIntelligenceFileSystemPort;
  projectRoot: string;
  parsedTask: ParsedContextPackTask;
  /** Bendras spec tekstui likęs simbolių biudžetas. */
  specCharBudget: number;
  maxSpecFragments: number;
};

export async function runSpecPhase(input: SpecPhaseInput): Promise<SpecPhaseResult> {
  // Fazė 1: paimami VISI ref'ai, kiekvienas apkarpomas iki bendro biudžeto ATSKIRAI.
  const candidates = await retrieveSpecFragmentCandidates(
    input.codeFs,
    input.projectRoot,
    input.parsedTask.specSources,
    input.specCharBudget,
  );

  // Reitingavimas nusprendžia, KOKIA TVARKA fragmentai gaus biudžetą — tad prie ankšto biudžeto
  // viso dokumento fallback'as atiduodamas anksčiau už tikslų antraštės atitikmenį.
  const ranked = rankRetrievalCandidates(candidates.fragments.map(toRetrievalCandidate), {
    query: retrievalQuery(input.parsedTask),
  });
  const ordered = ranked
    .map((entry) => candidates.fragments[entry.index])
    .filter((fragment): fragment is RetrievedFragment => fragment !== undefined);

  // Fazė 2: fragmentų limitas ir simbolių biudžetas — jau reitinguota tvarka.
  const selection = applySpecFragmentBudget(ordered, input.maxSpecFragments, input.specCharBudget);

  const allWarnings = [
    ...headingMissWarnings(selection.kept),
    ...candidates.unresolved.map(({ ref, reason }) => {
      if (reason === "candidate_limit") {
        return `spec source not retrieved: ${ref} (candidate limit ${MAX_SPEC_CANDIDATES} reached; the task lists too many spec sources)`;
      }
      if (reason === "outside_project") {
        return `spec source rejected: ${ref} (path escapes the project root; spec sources must be repo-relative)`;
      }
      if (reason === "read_failed") {
        return `spec source unreadable: ${ref} (skipped; the context pack was assembled without it)`;
      }
      return `spec source not found: ${ref}`;
    }),
    ...selection.dropped.map(({ ref, reason }) =>
      reason === "duplicate"
        ? `spec fragment dropped: ${ref} (duplicate reference in the task)`
        : reason === "fragment_limit"
          ? `spec fragment dropped: ${ref} (max_spec_fragments=${input.maxSpecFragments})`
          : `spec fragment dropped: ${ref} (context char budget exhausted)`,
    ),
  ];

  return {
    kept: selection.kept,
    warnings: capWarnings(allWarnings),
    // Apkarpyti fragmentai NESKAIČIUOJAMI: jie pack'e yra (jiems — `spec_fragment_truncated`).
    droppedCount: candidates.unresolved.length + selection.dropped.length,
  };
}

/**
 * Dvi nepataikymo priežastys, ir jos reikalauja SKIRTINGO veiksmo iš task'o autoriaus: arba
 * antraštė pervadinta (taisyk vardą), arba `#anchor` uždėtas ne Markdown failui (nuimk jį).
 * Prefiksas tas pats — jį skaito `headingMissCount` — skiriasi tik paaiškinimas.
 *
 * Priežastis imama iš `headingUnsupported`, kurį nustatė retrieval pagal GALUTINĮ kelią, o NE
 * išvedama iš `ref`. Išvedant iš ref'o change katalogo nuoroda (`AG/openspec/changes/x#foo`)
 * gautų melagingą „anchor veikia tik Markdown failuose", nors realiai buvo skaitomas
 * `proposal.md` ir antraštės tikrai ieškota — autorius nuimtų teisingą anchor'ą vietoj to, kad
 * pataisytų antraštės vardą.
 */
function headingMissWarnings(kept: readonly RetrievedFragment[]): string[] {
  return kept
    .filter((fragment) => fragment.headingMiss)
    .map((fragment) =>
      fragment.headingUnsupported
        ? `${SPEC_HEADING_MISS_WARNING} ${fragment.ref} (heading anchors work on markdown files only; fell back to whole-file text)`
        : `${SPEC_HEADING_MISS_WARNING} ${fragment.ref} (fell back to whole-file text, bounded by context budget)`,
    );
}

function capWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= MAX_SPEC_RETRIEVAL_WARNINGS) {
    return [...warnings];
  }
  return [
    ...warnings.slice(0, MAX_SPEC_RETRIEVAL_WARNINGS),
    `spec retrieval warnings truncated: ${warnings.length - MAX_SPEC_RETRIEVAL_WARNINGS} more not listed`,
  ];
}
