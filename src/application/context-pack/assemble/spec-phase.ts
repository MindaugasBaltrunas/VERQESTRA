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

/**
 * Įspėjimo SVARBA — lubų taikymo tvarka (2026-08-24, RAG auditas 4).
 *
 * Iki tol lubos buvo prioritetui AKLOS: imamos pirmos 10 eilučių surašymo tvarka, o ta tvarka
 * prasidėdavo antraščių nepataikymais. Task'as su dešimčia `#anchor` klaidų išstumdavo
 * `spec source rejected: … (path escapes the project root)` — ribų pažeidimo signalą, kurį
 * operatorius PRIVALO pamatyti, — ir prarastą spec'ą. Diagnostika, kuri pirma numeta savo
 * svarbiausią eilutę, yra blogesnė už jos nebuvimą, nes ji atrodo pilna.
 *
 * Skalė: mažesnis skaičius = anksčiau. Ji rūšiuoja STABILIAI, tad tos pačios svarbos eilutės
 * išlaiko surašymo tvarką.
 */
const WARNING_SEVERITY = {
  /** Kelias išeina iš projekto — ribų vartas suveikė. */
  rejected: 0,
  /** Šaltinis yra, bet neperskaitomas: teisės, symlink'as, lenktynės su trynimu. */
  unreadable: 1,
  /** Task'as nurodė šaltinį, kurio nėra. */
  missing: 2,
  /** Turinys buvo paimtas, bet į pack'ą nepateko — biudžetas ar limitas. */
  lost: 3,
  /** Task'o rašymo defektas, dėl kurio nieko neprarasta. */
  redundant: 4,
  /** Fragmentas pack'e YRA, tik platesnis nei prašyta. */
  imprecise: 5,
} as const;

export type SpecRetrievalWarning = { severity: number; text: string };

export type SpecPhaseResult = {
  /**
   * Fragmentai, patekę į pack'ą, reitinguota tvarka. Kirpimo būsena keliauja ANT pačių
   * fragmentų (`fragment.truncated`) — atskiro sąrašo čia sąmoningai nėra, nes assemble
   * `spec_fragment_truncated` išveda iš fragmentų, likusių PO graph-selection, o fazės
   * momentu to sąrašo dar negalima žinoti. Du to paties fakto šaltiniai išsiskirtų.
   */
  kept: RetrievedFragment[];
  /**
   * Įspėjimai su svarba ir BE lubų.
   *
   * Lubas uždeda kvietėjas (`capSpecRetrievalWarnings`), nes paskutinė praradimų stadija —
   * graph-first atranka — įvyksta jau PO šios fazės, ir jos įspėjimai privalo varžytis dėl tų
   * pačių lubų kartu su šiais. Anksčiau lubos buvo uždedamos čia, tad atrankos praradimai
   * neturėjo nė teorinės galimybės į sąrašą patekti.
   */
  warnings: SpecRetrievalWarning[];
  /** Metrikai: PRARASTŲ ref'ų skaičius, ne įspėjimų eilučių (tos turi lubas). */
  droppedCount: number;
};

/** Kiek ref'ų įvardijama vardais, kol eilutė nustoja būti skaitoma. */
const SPEC_DROP_REFS_LISTED = 5;

/**
 * Atrankos stadijoje numesti spec ref'ai — VIENA apribota eilutė, o ne po eilutę kiekvienam.
 *
 * Forma yra load-bearing (2026-08-24, RAG auditas 4). Įspėjimai guli PAČIAME pack'e, o pack'as
 * matuojamas prieš `max_context_chars`, tad kiekvienas jų simbolis atimamas iš to paties biudžeto,
 * dėl kurio fragmentai ir buvo numesti. Su eilute kiekvienam ref'ui perrinkimo ciklas ėmė mesti
 * DAUGIAU, kad tilptų diagnostika, o kiekvienas naujas praradimas pridėdavo dar vieną eilutę —
 * charakterizacijos `budget-shrink` atveju pack'as taip prarado VISUS fragmentus. Tai tiksliai ta
 * klasė, kurią 2026-08-21 audite uždarė `MAX_SPEC_RETRIEVAL_WARNINGS`: diagnostika neturi teisės
 * sugriauti to, ką diagnozuoja.
 *
 * Viena eilutė su apribotu vardų sąrašu turi PASTOVIAS lubas, tad ją galima rezervuoti iš anksto
 * (žr. `assemble`: rezervas matuojamas su blogiausiu atveju), ir realus pack'as niekada nebūna
 * didesnis už išmatuotą.
 */
export function specSelectionDropWarning(refs: readonly string[]): SpecRetrievalWarning | undefined {
  if (refs.length === 0) {
    return undefined;
  }
  const listed = refs.slice(0, SPEC_DROP_REFS_LISTED).join(", ");
  const rest = refs.length > SPEC_DROP_REFS_LISTED ? `, +${refs.length - SPEC_DROP_REFS_LISTED} more` : "";
  return {
    severity: WARNING_SEVERITY.lost,
    text: `spec fragments dropped by the context budget: ${refs.length} (${listed}${rest})`,
  };
}

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

  const warnings: SpecRetrievalWarning[] = [
    ...headingMissWarnings(selection.kept),
    ...candidates.unresolved.map(({ ref, reason }): SpecRetrievalWarning => {
      if (reason === "candidate_limit") {
        return {
          severity: WARNING_SEVERITY.lost,
          text: `spec source not retrieved: ${ref} (candidate limit ${MAX_SPEC_CANDIDATES} reached; the task lists too many spec sources)`,
        };
      }
      if (reason === "outside_project") {
        return {
          severity: WARNING_SEVERITY.rejected,
          text: `spec source rejected: ${ref} (path escapes the project root; spec sources must be repo-relative)`,
        };
      }
      if (reason === "read_failed") {
        return {
          severity: WARNING_SEVERITY.unreadable,
          text: `spec source unreadable: ${ref} (skipped; the context pack was assembled without it)`,
        };
      }
      return { severity: WARNING_SEVERITY.missing, text: `spec source not found: ${ref}` };
    }),
    ...selection.dropped.map(({ ref, reason }): SpecRetrievalWarning =>
      reason === "duplicate"
        ? {
            severity: WARNING_SEVERITY.redundant,
            text: `spec fragment dropped: ${ref} (duplicate reference in the task)`,
          }
        : reason === "fragment_limit"
          ? {
              severity: WARNING_SEVERITY.lost,
              text: `spec fragment dropped: ${ref} (max_spec_fragments=${input.maxSpecFragments})`,
            }
          : {
              severity: WARNING_SEVERITY.lost,
              text: `spec fragment dropped: ${ref} (context char budget exhausted)`,
            },
    ),
  ];

  return {
    kept: selection.kept,
    warnings,
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
function headingMissWarnings(kept: readonly RetrievedFragment[]): SpecRetrievalWarning[] {
  return kept
    .filter((fragment) => fragment.headingMiss)
    .map((fragment) => ({
      severity: WARNING_SEVERITY.imprecise,
      text: fragment.headingUnsupported
        ? `${SPEC_HEADING_MISS_WARNING} ${fragment.ref} (heading anchors work on markdown files only; fell back to whole-file text)`
        : `${SPEC_HEADING_MISS_WARNING} ${fragment.ref} (fell back to whole-file text, bounded by context budget)`,
    }));
}

/**
 * Lubos, taikomos SVARBOS tvarka.
 *
 * Rūšiuojama stabiliai (`index` — antrinis raktas), tad tos pačios svarbos eilutės išlaiko
 * surašymo tvarką ir pack'as lieka deterministinis. Nukirsta eilutė sako, kiek liko NEĮVARDYTA —
 * be jos sąrašas atrodytų pilnas.
 */
export function capSpecRetrievalWarnings(warnings: readonly SpecRetrievalWarning[]): string[] {
  const ordered = warnings
    .map((warning, index) => ({ warning, index }))
    .sort((left, right) => left.warning.severity - right.warning.severity || left.index - right.index)
    .map((entry) => entry.warning.text);
  if (ordered.length <= MAX_SPEC_RETRIEVAL_WARNINGS) {
    return ordered;
  }
  return [
    ...ordered.slice(0, MAX_SPEC_RETRIEVAL_WARNINGS),
    `spec retrieval warnings truncated: ${ordered.length - MAX_SPEC_RETRIEVAL_WARNINGS} more not listed`,
  ];
}
