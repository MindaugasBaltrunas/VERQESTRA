// Spec fragmentų paėmimas pagal task'o ref'us (`path` arba `path#heading`).
// Behaviour etalon: AG_loop rag-lite/retriever.ts retrieveSpecFragments (gyvoji pusė);
// FS — per portą (WBR VQ-301). retrieveRelevantChunks kelias — wont-migrate(dead).
//
// ## Kodėl DVI fazės, o ne viena funkcija (auditas A1, griežtinantis nukrypimas)
//
// Etalone paėmimas ir biudžetas buvo tas pats ciklas: ref'ai eidavo `## Spec source`
// surašymo tvarka, `usedChars` kaupdavosi, o išsekęs biudžetas `break`'indavo likusius.
// Reitingavimas (`rankRetrievalCandidates`) bėga PO to, tad jis galėjo tik perrikiuoti
// išgyvenusius — nei atkarpyti atgal, nei prikelti neišimto ref'o. Praktikoje tai reiškė,
// kad prie `max_context_chars: 12000` vienas pirmas viso dokumento ref'as suvalgydavo visą
// biudžetą, o trečias sąraše `spec.md#tiksli-antraštė` nebūdavo net perskaitytas. Kanoninė
// RAG-1 pakopų tvarka faktiškai negaliodavo — sprendė task'o autoriaus rašymo eilė.
//
// Todėl: `retrieveSpecFragmentCandidates` paima VISUS ref'us, kiekvieną apkarpydamas iki
// bendro biudžeto atskirai, o `applySpecFragmentBudget` biudžetą leidžia jau REITINGUOTA
// tvarka. Kvietėjas privalo tarp jų įterpti reitingavimą (žr. context-pack/assemble).
//
// ## Rūšies nustatymas (griežtinantis nukrypimas)
//
// Rūšis nustatoma per `statKind`, ne per `exists` + `stat`. Etalone
// `stat(...).catch(() => undefined)` reiškė, kad NEPERSKAITOMAS kelias virsdavo
// `stats?.isDirectory() === undefined` → falsy → „failas", ir `readFile` mesdavo EISDIR,
// nuversdamas VISĄ context pack'ą — būtent tas gedimas, nuo kurio saugo CHANGE_DIR_FILES
// išskleidimas. Dabar nežinia yra `absent`, o `absent` praleidžiamas kaip neegzistuojantis.

import path from "node:path";
import { resolveProjectPath } from "../../../shared/paths.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { chunkMarkdownByHeading } from "./markdown-chunks.js";

// Spec source gali būti change KATALOGAS (pvz. "AG/openspec/changes/<id>/") — katalogo
// skaitymas kaip failo mestų EISDIR ir anksčiau nuversdavo visą context pack'ą, siųsdamas
// šiaip validžius taskus į human review. Katalogo nuoroda todėl išskleidžiama į
// konvencinius change failus ta pačia tvarka kaip spec konteksto skaitytuvas.
//
// Eksportuojama, nes tą pačią rezoliuciją PRIVALO kartoti context-cache šaltinių rinkėjas:
// kitaip katalogo hash'as būtų amžina `absent` konstanta ir `proposal.md` redagavimas kešo
// neinvaliduotų (auditas A2).
export const CHANGE_DIR_FILES = ["proposal.md", "tasks.md", "spec.md", "design.md"] as const;

/**
 * Kandidatų lubos. Prioritetui AKLOS, todėl tai nėra `max_spec_fragments`: jos egzistuoja
 * vien tam, kad sugadintas ar sugeneruotas task'as su šimtais ref'ų negalėtų varyti
 * neribotos IO. Rankomis rašomas `## Spec source` blokas realiai turi vienetus įrašų, tad
 * ribos pasiekimas yra task'o defekto požymis ir apie jį pranešama.
 */
export const MAX_SPEC_CANDIDATES = 64;

export type RetrievedFragment = {
  ref: string;
  text: string;
  // Set to the requested heading text when `ref` asked for `#heading` on a markdown
  // file and no chunk matched it. Callers must surface this instead of treating the
  // whole-file fallback below as a silent, unbounded expansion.
  headingMiss?: string;
  /**
   * `headingMiss` priežastis: antraštės NEBUVO IEŠKOTA, nes galutinis failas ne Markdown.
   * Be jos kvietėjas priežastį spėtų iš `ref`, o change katalogo nuorodai tai duotų klaidingą
   * atsakymą — ji `.md` nesibaigia, nors realiai skaitomas `proposal.md`.
   */
  headingUnsupported?: true;
  /**
   * Tekstas nukirptas biudžeto: fragmentas pack'e YRA, bet jis NEPILNAS. Būsena keliauja su
   * pačiu fragmentu, o ne atskirame sąraše, nes atskirą įspėjimą renderis gali išmesti anksčiau
   * už patį fragmentą — ir tada worker'is nepilną specifikaciją laikytų pilna.
   */
  truncated?: true;
};

/**
 * Kiek biudžeto verta paaukoti dėl švarios ribos. Žemiau šios dalies pjūvis daromas aklai:
 * geriau turėti 100 % biudžeto nutrūkusį sakinio viduryje, nei 20 % gražiai užbaigtų.
 */
export const BOUNDARY_MIN_RATIO = 0.6;

/**
 * Kerpa tekstą ties PASKUTINE pilna pastraipa (arba eilute), telpančia į biudžetą.
 *
 * Aklas `slice` nutraukia žodžio ar sakinio viduryje, ir toks fragmentas skaitomas kaip
 * pilnas — tik nelogiškas. Pastraipos riba palieka tekstą, kuris bent jau savaime nuoseklus.
 * Grynas ir deterministinis: tas pats tekstas ir tas pats limitas visada duoda tuos pačius baitus.
 */
export function clipToBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const window = text.slice(0, maxChars);
  const floor = Math.floor(maxChars * BOUNDARY_MIN_RATIO);
  for (const separator of ["\n\n", "\n"]) {
    const cut = window.lastIndexOf(separator);
    if (cut >= floor) {
      return window.slice(0, cut);
    }
  }
  return window;
}

/** Ref'as, kurio fragmento pack'e nebus, ir priežastis. Tyli praradimo forma yra klaida (A4). */
export type UnresolvedSpecSource = {
  ref: string;
  reason: "not_found" | "candidate_limit" | "outside_project" | "read_failed";
};

/** `path` iš `path#heading`. Eksportuojama, nes kešo šaltinių rinkėjas privalo skaidyti VIENODAI. */
export function specRefFilePart(ref: string): string {
  const hashIndex = ref.indexOf("#");
  return (hashIndex === -1 ? ref : ref.slice(0, hashIndex)).trim();
}

/**
 * Ref'o kelias projekto viduje arba `undefined`, jei jis iš projekto išeina.
 *
 * Spec ref'as ateina iš task'o Markdown teksto, o jo turinys keliauja TIESIAI į LLM promptą
 * ir į context cache. Preflight paprastus `../` bei absoliučius kelius atmeta, bet retrieval
 * negali tuo remtis: context-pack surinkimas kviečiamas ir tiesiogiai, aplenkiant preflight.
 * Todėl vartas kartojamas ČIA, o ne tik prieš srovę.
 *
 * `allowAbsoluteInsideRoot: false` — absoliutus kelias task'e atmetamas net jei jis rodo į
 * projekto vidų: task'ai rašomi repo-santykiniais keliais, tad absoliutus yra anomalija.
 *
 * Grąžinama `undefined`, o ne metama: vienas blogas ref'as neturi teisės nuversti viso
 * context pack'o. Kvietėjas jį deklaruoja kaip `outside_project`.
 *
 * Tai LEKSINIS vartas. Symlink'as, gulintis projekto viduje ir rodantis į išorę, jį praeina —
 * jį gaudo FS adapterio `realpath` patikra (infrastructure/fs/code-intelligence-fs-adapter).
 */
function containedSpecPath(projectRoot: string, filePart: string): string | undefined {
  try {
    return resolveProjectPath(projectRoot, filePart, { allowAbsoluteInsideRoot: false }, "spec source");
  } catch {
    return undefined;
  }
}

export type SpecFragmentCandidates = {
  fragments: RetrievedFragment[];
  unresolved: UnresolvedSpecSource[];
};

export type DroppedSpecFragment = { ref: string; reason: "duplicate" | "fragment_limit" | "char_budget" };

export type SpecFragmentSelection = {
  kept: RetrievedFragment[];
  dropped: DroppedSpecFragment[];
  /** Ref'ai, kurie pack'e YRA, bet biudžeto apkarpyti — nepilnas spec'as klaidina tyliai. */
  truncated: string[];
};

/**
 * Fazė 1: paima kiekvieną ref'ą, kiekvieną atskirai apkarpydamas iki `maxCharsPerFragment`.
 * Bendro biudžeto NEDALIJA ir ref'ų neprioritetizuoja — tai `applySpecFragmentBudget`
 * darbas, atliekamas jau po reitingavimo.
 */
export async function retrieveSpecFragmentCandidates(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  refs: string[],
  maxCharsPerFragment: number,
): Promise<SpecFragmentCandidates> {
  const fragments: RetrievedFragment[] = [];
  const unresolved: UnresolvedSpecSource[] = [];

  for (const [index, ref] of refs.entries()) {
    if (!ref.trim()) {
      continue;
    }
    if (index >= MAX_SPEC_CANDIDATES) {
      unresolved.push({ ref, reason: "candidate_limit" });
      continue;
    }
    const filePath = containedSpecPath(projectRoot, specRefFilePart(ref));
    if (filePath === undefined) {
      unresolved.push({ ref, reason: "outside_project" });
      continue;
    }

    // Skaitymo klaida (teisės, symlink'ą atmetęs adapterio vartas, lenktynės su trynimu)
    // paverčiama praleistu ref'u, o ne pack'o griūtimi. Tylu tai NĖRA: `unresolved` eina į
    // `spec_fragment_warnings`, tad prarastas spec'as lieka matomas ir agentui, ir operatoriui.
    let fragment: RetrievedFragment | undefined;
    try {
      fragment = await retrieveOneFragment(fs, filePath, ref, maxCharsPerFragment);
    } catch {
      unresolved.push({ ref, reason: "read_failed" });
      continue;
    }
    if (fragment === undefined) {
      unresolved.push({ ref, reason: "not_found" });
      continue;
    }
    fragments.push(fragment);
  }

  return { fragments, unresolved };
}

/**
 * Fazė 2: bendras simbolių biudžetas ir fragmentų limitas leidžiami PADUOTA tvarka, kuri
 * turi būti reitinguota. Paskutinis netelpantis fragmentas apkarpomas iki likučio (etalono
 * elgsena), o ne metamas — bet apie tai pranešama.
 */
export function applySpecFragmentBudget(
  fragments: readonly RetrievedFragment[],
  maxFragments: number,
  maxChars: number,
): SpecFragmentSelection {
  const kept: RetrievedFragment[] = [];
  const dropped: DroppedSpecFragment[] = [];
  const truncated: string[] = [];
  const seen = new Set<string>();
  let usedChars = 0;

  for (const fragment of fragments) {
    // Tas pats ref'as, surašytas `## Spec source` du kartus, anksčiau suvalgydavo biudžetą
    // DUKART, o dublikatą vis tiek išmesdavo vėlesnis `dedupeStable` atrankoje — grynas
    // biudžeto praradimas. Dedup daromas čia, PRIEŠ išlaidas, ir apie jį pranešama, nes tai
    // task'o rašymo defektas.
    const identity = `${fragment.ref}\n${fragment.text}`;
    if (seen.has(identity)) {
      dropped.push({ ref: fragment.ref, reason: "duplicate" });
      continue;
    }
    seen.add(identity);

    if (kept.length >= maxFragments) {
      dropped.push({ ref: fragment.ref, reason: "fragment_limit" });
      continue;
    }
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      dropped.push({ ref: fragment.ref, reason: "char_budget" });
      continue;
    }
    const text = clipToBoundary(fragment.text, remaining);
    // Kirpimas galėjo įvykti JAU pirmoje fazėje (per-fragmento lubos), tad būsena sudedama,
    // o ne perrašoma: kitaip antrą kartą nekirptas, bet anksčiau nukirptas fragmentas
    // atkeliautų pas worker'į be jokios žymos.
    const wasTruncated = fragment.truncated === true || text.length < fragment.text.length;
    if (wasTruncated) {
      truncated.push(fragment.ref);
    }
    kept.push({ ...fragment, text, ...(wasTruncated ? { truncated: true as const } : {}) });
    usedChars += text.length;
  }

  return { kept, dropped, truncated };
}

/** `resolvedPath` jau IŠSPRĘSTAS ir patikrintas dėl projekto ribų — žr. `containedSpecPath`. */
async function retrieveOneFragment(
  fs: CodeIntelligenceFileSystemPort,
  resolvedPath: string,
  ref: string,
  maxChars: number,
): Promise<RetrievedFragment | undefined> {
  const hashIndex = ref.indexOf("#");
  const headingRef = hashIndex === -1 ? "" : ref.slice(hashIndex + 1).trim();

  let filePath = resolvedPath;
  // Viena `statKind` užklausa atsako į abu klausimus (ar yra / kokia rūšis). `absent` sulydo
  // „nėra" su „rūšies nustatyti nepavyko", ir abu čia baigiasi vienodai — ref praleidžiamas.
  const kind = await fs.statKind(filePath);
  if (kind === "absent") {
    return undefined;
  }

  if (kind === "directory") {
    const resolved = await resolveChangeDirFile(fs, filePath);
    if (resolved === undefined) {
      return undefined;
    }
    filePath = resolved;
  }

  const fullText = (await fs.readTextFile(filePath)).trim();
  // Markdown rūšis nustatoma pagal GALUTINĮ kelią, ne pagal ref'e parašytą. Change katalogo
  // nuoroda (`AG/openspec/changes/<id>#Heading`) originaliai nesibaigia `.md`, tad anksčiau
  // antraščių paieška jai tyliai neįsijungdavo ir `#Heading` būdavo ignoruojamas — būtent toms
  // nuorodoms, kurias šis projektas naudoja dažniausiai. Po išskleidimo tai `proposal.md`.
  const isMarkdown = filePath.toLowerCase().endsWith(".md");
  const matchedSection = headingRef && isMarkdown ? matchHeadingSection(fullText, headingRef) : undefined;
  // `isMarkdown` sprendžia, ar antraštės APSKRITAI ieškoma, bet NE tai, ar nepataikymas
  // fiksuojamas. Anksčiau jis dalyvavo abiejose sąlygose, tad `config.json#foo` buvo
  // grąžinamas kaip VISAS failas su `headingMiss === undefined` — o `toRetrievalCandidate` iš
  // to daro `headingMatched: true`, tad ne-Markdown nuoroda gaudavo `heading_match` pakopą,
  // skirtą TIKSLIAI rastai sekcijai, ir jokio įspėjimo. Prašyta sekcija negauta yra
  // nepataikymas nepriklausomai nuo to, kodėl jos nebuvo ieškota.
  const headingMiss = headingRef && matchedSection === undefined ? headingRef : undefined;
  const text = matchedSection ?? fullText;
  const clipped = clipToBoundary(text, maxChars);

  return {
    ref,
    text: clipped,
    ...(headingMiss ? { headingMiss } : {}),
    // KODĖL sekcijos negauta — sprendžiama ČIA, kur žinomas GALUTINIS kelias, ir keliauja su
    // fragmentu. Kvietėjas to atgal iš `ref` išvesti negali: change katalogo nuoroda
    // (`AG/openspec/changes/x#foo`) `.md` nesibaigia, nors realiai buvo skaitomas `proposal.md`
    // ir antraštės TIKRAI ieškota. Išvedinėjant iš ref'o toks atvejis gautų melagingą patarimą
    // „anchor veikia tik Markdown failuose", ir autorius nuimtų teisingą `#foo` vietoj to, kad
    // pataisytų antraštės vardą.
    ...(headingMiss && !isMarkdown ? { headingUnsupported: true as const } : {}),
    // Ir per-fragmento lubos yra kirpimas. Be šitos žymos antroji fazė lygintų jau nukirptą
    // tekstą su savimi ir kirpimo nepamatytų — tyli spraga pačiame pranešimo mechanizme.
    ...(clipped.length < text.length ? { truncated: true as const } : {}),
  };
}

/**
 * Katalogas be konvencinių change failų grąžina `undefined` ir praleidžiamas kaip
 * neegzistuojantis ref. Kandidatui reikalaujama būtent `file`: `proposal.md` pavadinimo
 * katalogas kitaip nukeliautų į `readTextFile` ir mestų tą patį EISDIR.
 */
async function resolveChangeDirFile(
  fs: CodeIntelligenceFileSystemPort,
  directory: string,
): Promise<string | undefined> {
  for (const candidate of CHANGE_DIR_FILES) {
    const candidatePath = path.join(directory, candidate);
    if ((await fs.statKind(candidatePath)) === "file") {
      return candidatePath;
    }
  }
  return undefined;
}

/**
 * Prašytos antraštės SEKCIJA — kartu su visais gilesniais poskyriais.
 *
 * `chunkMarkdownByHeading` yra plokščias: jis nutraukia gabalą ties BET KURIA kita antrašte.
 * Paimtas gabalas vienas pats reiškia, kad `## API` atkeliauja be savo `### Request` ir
 * `### Response` — o būtent jie ir yra tai, ko task'as prašė. Blogiausia, kad tai atrodo kaip
 * sėkmė: `headingMiss` netaikomas, tad niekas nepraneša apie nukirstą turinį.
 *
 * Sekcija todėl baigiama tik ties TOKIO PATIES ar aukštesnio lygio antrašte, kaip Markdown
 * hierarchija ir reiškia. Chunker'is lieka plokščias — jis yra sąžiningas etalono perkėlimas,
 * o hierarchija yra šio, sekcijas imančio, kvietėjo semantika.
 */
function matchHeadingSection(markdown: string, headingRef: string): string | undefined {
  const normalizedRef = normalizeHeading(headingRef);
  if (!normalizedRef) {
    return undefined;
  }

  const chunks = chunkMarkdownByHeading(markdown);
  const startIndex = chunks.findIndex((chunk) => normalizeHeading(chunk.heading) === normalizedRef);
  const start = chunks[startIndex];
  if (start === undefined) {
    return undefined;
  }
  // `<root>` (lygis 0) yra sintetinis gabalas tekstui PRIEŠ pirmą antraštę. Jis neturi savo
  // poskyrių — visas dokumentas nėra jo vaikas — tad grąžinamas vienas.
  if (start.level === 0) {
    return start.text;
  }

  const section = [start.text];
  for (const chunk of chunks.slice(startIndex + 1)) {
    if (chunk.level <= start.level) {
      break;
    }
    section.push(chunk.text);
  }
  return section.join("\n\n");
}

/**
 * Antraštė → palyginimo raktas.
 *
 * UNICODE, o ne ASCII (2026-08-23, operatoriaus radinys). Iki tol raktas buvo `[^a-z0-9]+ → "-"`,
 * tad viskas, kas ne lotyniška, iškrisdavo:
 *
 *   Интерфейс → ""           sekcija NERANDAMA, ir RAG grąžindavo VISĄ dokumentą kaip fallback
 *   接口      → ""           tas pats
 *   Sąsaja    → "s-saja"     lietuviška raidė iškrenta — repo, kurio dokumentai lietuviški
 *   Überblick → "berblick"   pirma raidė iškrenta
 *   Раздел 2  → "2"          susilietų su bet kuria „## 2" antrašte
 *
 * Tuščias raktas buvo blogiausias iš jų: `matchHeadingSection` grąžindavo `undefined`, ir vietoj
 * vienos sekcijos į pack'ą patekdavo visas dokumentas — tyliai, biudžeto sąskaita, išstumdamas
 * kitus įrodymus. Antrasis blogumas — SUSILIEJIMAI: skirtingos antraštės gaudavo tą patį raktą.
 *
 * NFC pirma, nes ta pati raidė gali ateiti sudėtine forma (`ą` = `a` + U+0328), ir be
 * normalizacijos dvi vizualiai vienodos antraštės duotų skirtingus raktus.
 *
 * Diakritikos NEnuimame: `Sąsaja` ir `Sasaja` yra skirtingos antraštės, ir jų suliejimas būtų ta
 * pati susiliejimo klaida kita kryptimi.
 */
function normalizeHeading(heading: string): string {
  return heading
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
