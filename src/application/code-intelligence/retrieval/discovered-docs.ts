// Neįvardytų kandidatų atradimas context pack'ui (task 006, po A3 pakopų trynimo).
//
// `ranking.ts` A3 pastaba numatė būtent šią užduotį: „jei kada prireiks reitinguoti
// neįvardytus kandidatus (pvz. laisvos formos užduotims be `## Spec source`), tai
// projektuojama iš naujo kartu su savo biudžetu ir tokenizatoriumi — šitų pakopų prikelti
// nereikia". Etalono rag-lite/indexer.ts + retriever.ts (retrieveRelevantChunks) discovery
// buvo `wont-migrate(dead)` (VQ-002 §3.5, 0 produkcinių kvietėjų) — šis modulis JO
// NEATKURIA, o sprendžia tą pačią problemą IŠ NAUJO, siaurai apibrėžtai paskirčiai.
//
// ## Kodėl ATSKIRAI nuo `rankRetrievalCandidates` (griežtinantis dizaino sprendimas)
//
// `ranking.ts` trijų pakopų modelis (`direct_spec_reference` / `heading_match` /
// `general_docs`) remiasi prielaida „kandidatas visada ateina iš task'o `## Spec source`
// bloko" (žr. `RetrievalCandidate` komentarą tame faile). Čia gaminami kandidatai tos
// prielaidos NETENKINA — task'as jų neįvardijo, ir joks `#heading` niekada nebuvo prašytas.
// Maišyti abi sroves per tą pačią f-ją reikštų arba sulaužyti prielaidą (kiekvienas
// kvietėjas turėtų atspėti, ar konkretus kandidatas yra „named"), arba atkurti IŠTRINTĄ
// `directSpecReference` lauką vien tam, kad discovery liktų neaktyvus dead code, kaip ir
// etalone. Vietoj to — savas, siauras ciklas: BM25 balas sprendžia VISKĄ (nulinis balas =
// jokio lexinio ryšio su užklausa = kandidatas atmetamas), joks kandidatas neįgyja
// `direct_spec_reference` ar `heading_match` pakopos, ir šis modulis niekada nesikerta su
// `rankRetrievalCandidates` sprendimų erdve.
//
// ## Kodėl UŽDARAS šaknų sąrašas, o ne viso repo skenavimas
//
// Tai NE bendras dokumentų discovery (toks liktų `wont-migrate` dėl tos pačios priežasties
// kaip etalone: prie ankšto konteksto biudžeto spekuliatyvūs atitikmenys išstumtų aiškiai
// įvardytą turinį). `CONTROL_DOC_ROOTS` yra žinoma, operatoriaus kuruojama sritis —
// analogiška etalono `rag-lite/indexer.ts controlRoots`, pritaikyta šio repo išdėstymui.
//
// ## Kodėl NEPRIJUNGTA prie `assemble.ts` šiame task'e
//
// Wiring'as reikalautų arba (a) šiuos kandidatus įtraukti į kešuojamą `context-pack.json`
// turinį — bet `ContextCachePort.collectSources` (infrastructure/persistence, šio task'o
// scope NEĮEINA) nehash'uoja `CONTROL_DOC_ROOTS` turinio, tad cache HIT tyliai grąžintų
// pasenusį discovered tekstą būtent tokį CLAUDE.md draudžia (CONTEXT_CACHE_VERSION taisyklė:
// „senas įrašas grįžta kaip hit ir tyliai anuliuoja pataisymą"); arba (b) juos skaičiuoti iš
// naujo PO cache lookup abiem šakoms (kaip renderis — žr. render-execution-context.ts
// komentarą „generuojamas iš naujo kiekvieno hit'o metu") — bet tam reikėtų pack'o formos
// pakeitimo IR papildomo FS skaitymo abiem šakoms, kas peržengia „suprojektuoti retrieval"
// šio task'o ribas. Modulis todėl paliekamas PAREIGINGAI PARUOŠTAS: gryna, testuota funkcija,
// kurią kvietėjas gali sujungti su `assemble.ts` atskiru task'u, kartu su cache šaltinio
// papildymu.

import path from "node:path";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { chunkMarkdownByHeading } from "./markdown-chunks.js";
import { bm25Scores } from "./ranking.js";
import { clipToBoundary } from "./spec-fragments.js";

/**
 * Fiksuoti kontrolinių dokumentų šaknys. UŽDARAS sąmoningai (žr. failo antraštę): ne viso
 * repo discovery, o žinoma, mažai kintanti operatoriaus dokumentacijos sritis.
 */
export const CONTROL_DOC_ROOTS = ["README.md", "docs", "AG/spec", "AG/openspec", ".claude/rules"] as const;

/** IO lubos — kiek `.md` failų surinkimas gali perskaityti vienam kvietimui. */
export const MAX_DISCOVERED_DOC_FILES = 200;

/** Kandidatų (antraščių gabalų) lubos PRIEŠ reitingavimą — apsauga nuo per didelio korpuso. */
export const MAX_DISCOVERED_DOC_CANDIDATES = 500;

/** Katalogų gylio lubos — apsauga nuo simlink'ų ciklo be jokio `.md` failo per kelią. */
const MAX_DISCOVERY_DEPTH = 8;

export type DiscoveredDocCandidate = {
  /** `path` arba `path#heading` — sintetinis ref, generuojamas ČIA, ne task'o teksto. */
  ref: string;
  text: string;
};

/**
 * Nuskaito `CONTROL_DOC_ROOTS` ir grąžina kiekvieno rasto `.md` failo antraščių gabalus kaip
 * neįvertintus kandidatus. Tvarka deterministinė (failai — surūšiuoti keliu, gabalai — failo
 * eilučių tvarka), tad tas pats medis visada duoda tą pačią kandidatų seką.
 */
export async function discoverControlDocCandidates(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<DiscoveredDocCandidate[]> {
  const files = await listControlDocFiles(fs, projectRoot);
  const candidates: DiscoveredDocCandidate[] = [];

  for (const relativePath of files) {
    if (candidates.length >= MAX_DISCOVERED_DOC_CANDIDATES) {
      break;
    }
    let markdown: string;
    try {
      markdown = await fs.readTextFile(path.join(projectRoot, relativePath));
    } catch {
      // Skaitymo klaida (teisės, lenktynės su trynimu) — failas praleidžiamas, discovery
      // nenutrūksta: tai geriausios-pastangos papildomas kontekstas, ne privalomas.
      continue;
    }
    for (const chunk of chunkMarkdownByHeading(markdown)) {
      if (candidates.length >= MAX_DISCOVERED_DOC_CANDIDATES) {
        break;
      }
      const ref = chunk.heading === "<root>" ? relativePath : `${relativePath}#${chunk.heading}`;
      candidates.push({ ref, text: chunk.text });
    }
  }
  return candidates;
}

async function listControlDocFiles(fs: CodeIntelligenceFileSystemPort, projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of CONTROL_DOC_ROOTS) {
    const absoluteRoot = path.join(projectRoot, root);
    const kind = await fs.statKind(absoluteRoot);
    if (kind === "file") {
      if (root.toLowerCase().endsWith(".md")) {
        files.push(toPosix(root));
      }
    } else if (kind === "directory") {
      await collectMarkdownFiles(fs, projectRoot, absoluteRoot, files, 0);
    }
    // `absent` — šaknis šiame projekte tiesiog nėra (pvz. `.claude/rules` neįdiegtas
    // projekte); praleidžiama tyliai, kaip ir `readArchitectureGraph` elgiasi su nesamu
    // grafo failu.
  }
  return [...new Set(files)].sort().slice(0, MAX_DISCOVERED_DOC_FILES);
}

async function collectMarkdownFiles(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  absoluteDir: string,
  out: string[],
  depth: number,
): Promise<void> {
  if (out.length >= MAX_DISCOVERED_DOC_FILES || depth >= MAX_DISCOVERY_DEPTH) {
    return;
  }
  const entries = await fs.listDirectory(absoluteDir);
  for (const entry of entries) {
    if (out.length >= MAX_DISCOVERED_DOC_FILES) {
      return;
    }
    const absoluteChild = path.join(absoluteDir, entry.name);
    if (entry.isDirectory) {
      await collectMarkdownFiles(fs, projectRoot, absoluteChild, out, depth + 1);
    } else if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
      out.push(toPosix(path.relative(projectRoot, absoluteChild)));
    }
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Reitinguoja discovered kandidatus prieš užklausą. SAVO ciklas (žr. failo antraštę) — ne
 * `rankRetrievalCandidates` pratęsimas. `bm25Scores` naudojamas kaip GRYNA, jau audituota
 * f-ja (Unicode tokenizatorius, A3/A6): tai pakartotinis naudojimas, ne pakopų modelio
 * prikėlimas — pati f-ja neneša jokios pakopos sampratos.
 *
 * Nulinis balas = jokio lexinio ryšio su užklausa = kandidatas ATMETAMAS, o ne paliekamas
 * `general_docs` tipo fallback'u. Skirtingai nei named spec ref'as, kurio task'as PRAŠĖ ir
 * kurio nebuvimas privalo būti matomas, discovered kandidatas be jokio ryšio su užklausa
 * tiesiog nėra įrodymas — jo įtraukimas tik išstumtų kitą, geresnį discovered kandidatą.
 */
export function rankDiscoveredDocCandidates(
  candidates: readonly DiscoveredDocCandidate[],
  query: string,
): DiscoveredDocCandidate[] {
  const scores = bm25Scores(
    candidates.map((candidate) => `${candidate.ref}\n${candidate.text}`),
    query,
  );
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scores[index] ?? 0 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

export type SelectedDiscoveredDocs = {
  kept: DiscoveredDocCandidate[];
  /** Ref'ai, kurių tekstas nukirptas biudžeto — tas pats matomumo principas kaip spec fragmentams. */
  truncated: string[];
};

/**
 * Savo biudžetas (žr. failo antraštę): kvietėjas duoda `maxCandidates`/`maxChars`, kurie
 * NEBŪTINAI sutampa su spec fragmentų `max_spec_fragments`/spec char biudžetu — tai atskira
 * kontekstinė sritis, kuri neturi teisės išstumti aiškiai įvardyto turinio.
 */
export function selectDiscoveredDocs(
  ranked: readonly DiscoveredDocCandidate[],
  maxCandidates: number,
  maxChars: number,
): SelectedDiscoveredDocs {
  const kept: DiscoveredDocCandidate[] = [];
  const truncated: string[] = [];
  let usedChars = 0;

  for (const candidate of ranked) {
    if (kept.length >= maxCandidates) {
      break;
    }
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      break;
    }
    const text = clipToBoundary(candidate.text, remaining);
    if (text.length === 0) {
      // Šis kandidatas per didelis likučiui net su kirpimu ties riba (spec-fragments.ts
      // `clipToBoundary` elgesys) — kitas, trumpesnis kandidatas dar gali tilpti pilnas.
      continue;
    }
    if (text.length < candidate.text.length) {
      truncated.push(candidate.ref);
    }
    kept.push({ ref: candidate.ref, text });
    usedChars += text.length;
  }
  return { kept, truncated };
}
