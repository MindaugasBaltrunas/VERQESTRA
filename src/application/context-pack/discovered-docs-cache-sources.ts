// `CONTROL_DOC_ROOTS` turinio tapatybė context cache raktui (task 101-b).
//
// Discovered docs prijungimo (task 101-c) būtina sąlyga: jei kontrolinių dokumentų medžio
// turinys pasikeičia, o cache raktas to nemato, `lookupContextCache` grąžina HIT su PASENUSIU
// discovered tekstu — būtent tas tylus anuliavimas, kurį draudžia `CONTEXT_CACHE_VERSION`
// taisyklė. Šis modulis TIK gamina šaltinius; kvietėjo pusė (`cacheSources` sąrašas
// `assemble.ts`) — 101-c, kaip ir versijos kėlimas.
//
// Forma pagal `compression-cache-sources.ts`: gryna funkcija, IO tik per jau esamą portą,
// jokių naujų priklausomybių, jokio `ContextCachePort.collectSources` kontrakto keitimo —
// šaltiniai pridedami kvietėjo pusėje, kaip `codeGraphModeCacheSource`.
//
// ## Kodėl hash'uojami DISCOVERY kandidatai, o ne failų baitai
//
// Šaltinis privalo dengti tiksliai tai, kas patenka į pack'ą. Savo medžio apėjimas čia būtų
// `listControlDocFiles` kopija, o jos suderinti neįmanoma: `MAX_DISCOVERY_DEPTH` ir `.md`
// filtras yra PRIVATŪS `discovered-docs.ts` viduje. Diverguodama kopija gali klysti į abi
// puses, ir viena iš jų yra būtent tas defektas, kurį šis task'as uždaro: dokumentas, kurį
// discovery MATO, o šaltinių rinkėjas — ne, grįžtų kaip tylus stale hit'as. Todėl tapatybė
// išvedama iš `discoverControlDocCandidates` išvesties — to paties šaltinio, iš kurio
// 101-c ims `docsSnippets`. Tai ta pati kryptis kaip `contextCompressionArrestCacheSource`:
// hash'uojamas EFEKTAS, ne artefakto baitai.
//
// Šalutinė nauda: ribas (`MAX_DISCOVERED_DOC_FILES`, `MAX_DISCOVERED_DOC_CANDIDATES`)
// pritaiko pati discovery, tad už jų likęs dokumentas šaltinių nepapildo — ir teisingai,
// nes į pack'ą jis irgi nepatenka.

import { createHash } from "node:crypto";
import { discoverControlDocCandidates, type DiscoveredDocCandidate } from "../code-intelligence/retrieval/discovered-docs.js";
import type { CodeIntelligenceFileSystemPort } from "../code-intelligence/ports.js";
import type { ContextCacheSource } from "./context-cache-model.js";

/**
 * Kelio prefiksas, skiriantis discovered dokumentą nuo TO PATIES failo, kurį task'as įvardijo
 * `## Spec source` bloke. Be jo `AG/spec/x.md` rinkinyje atsirastų du kartus su skirtingais
 * hash'ais (baitai vs kandidatų projekcija), ir operatorius, skaitantis cache įrašą, matytų
 * prieštarą vietoj dviejų skirtingų įrodymų. Sintetinio kelio precedentas —
 * `codeGraphModeCacheSource` (`context-cache-key.ts`).
 */
export const DISCOVERED_DOCS_SOURCE_PREFIX = "context-pack/discovered-docs/";

/**
 * Kontrolinių dokumentų šaknų turinio tapatybė — po vieną `ContextCacheSource` kiekvienam
 * dokumentui, kuris realiai davė bent vieną discovery kandidatą.
 *
 * Rūšis `spec`: tai dokumentų TURINIO įrodymas, tos pačios prigimties kaip įvardyti spec
 * ref'ai, tad drift'as atributuojamas į `spec` komponentą. `policy` čia meluotų — jis reiškia
 * orkestratoriaus konfigūraciją, ir README pataisymas atrodytų kaip politikos pakeitimas.
 *
 * Tvarka deterministinė: kandidatai ateina jau surūšiuoti keliu (dedup+sort PRIEŠ
 * `MAX_DISCOVERED_DOC_FILES` ribą), o išvestis dar kartą rūšiuojama kelio kodų vienetais —
 * ne `localeCompare`, kurio tvarka priklauso nuo ICU lokalės, tad tas pats medis skirtinguose
 * procesuose duotų skirtingą raktą.
 *
 * Tuščia arba nesama šaknis nėra klaida: `discoverControlDocCandidates` ją praleidžia tyliai,
 * ir rinkinys tiesiog lieka tuščias.
 */
export async function discoveredDocsCacheSources(input: {
  fs: CodeIntelligenceFileSystemPort;
  projectRoot: string;
}): Promise<ContextCacheSource[]> {
  const candidates = await discoverControlDocCandidates(input.fs, input.projectRoot);
  const byDocument = new Map<string, string[]>();

  for (const candidate of candidates) {
    const documentPath = discoveredDocPath(candidate.ref);
    const frames = byDocument.get(documentPath);
    if (frames === undefined) {
      byDocument.set(documentPath, [candidateFrame(candidate)]);
    } else {
      frames.push(candidateFrame(candidate));
    }
  }

  return [...byDocument.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([documentPath, frames]) => ({
      kind: "spec" as const,
      path: `${DISCOVERED_DOCS_SOURCE_PREFIX}${documentPath}`,
      hash: createHash("sha256").update(frames.join(""), "utf8").digest("hex"),
    }));
}

/**
 * Ref'as yra `path` arba `path#heading` (`discovered-docs.ts` generuoja jį pats), tad
 * dokumento kelias yra dalis iki PIRMO `#`: antraštėje `#` gali būti, kelyje — praktiškai ne.
 * Blogiausiu atveju du dokumentai suplauktų į vieną kibirą — jų turinys vis tiek lieka
 * hash'e, tad prarandamas tik atributavimo tikslumas, ne invariantas.
 */
function discoveredDocPath(ref: string): string {
  const anchor = ref.indexOf("#");
  return anchor === -1 ? ref : ref.slice(0, anchor);
}

/**
 * Kandidato kadras su ILGIO prefiksu. Skirtukas (`\n---\n` ar panašus) čia netiktų: jis gali
 * pasitaikyti pačiame Markdown tekste, ir tada du skirtingi kandidatų rinkiniai suplaktų į tą
 * patį hash'ą. Įtraukiamas ir `ref` — jis keliauja į pack'ą kaip kandidato tapatybė, tad
 * antraštės pervadinimas be turinio pakeitimo taip pat privalo pakeisti raktą.
 */
function candidateFrame(candidate: DiscoveredDocCandidate): string {
  const payload = `${candidate.ref}\n${candidate.text}`;
  return `${payload.length}:${payload}`;
}
