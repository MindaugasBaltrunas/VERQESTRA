// Context-cache įrašo schema ir sentineliai — gyvena PRIE context-pack klasterio (WBR E3:
// schema prie savo modulio). Pati cache persistencija (skaitymas/rašymas/evikcija) — E4;
// čia tik forma, kurią gamina assembly ir kurios identitetu remiasi cache raktas.
// Behaviour etalon: AG_loop core/schema.ts context-cache blokas + orchestrator/runtime/
// context-cache.ts konstantos.

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

/**
 * Cache įrašo formato IR pack'o semantikos versija. Dalyvauja dviejuose vartuose: fingerprint'e
 * (kitas raktas — kitas failas) ir `lookupContextCache` patikroje (senesnė versija evict'inama).
 *
 * KELTI PRIVALOMA, kai pasikeičia bet kas, kas veikia SUKURTO pack'o turinį, net jei šaltinių
 * failai nepasikeitė. Šaltinių hash'ai to nepagauna: jie mato duomenis, ne kodą. Nepakėlus,
 * senas įrašas grįžta kaip `hit` ir tyliai anuliuoja pataisymą.
 *
 * Sąrašas, kas reikalauja kėlimo:
 *  - retrieval semantika (antraščių sekcijos, katalogų išskleidimas, ribų vartai, kirpimas);
 *  - reitingavimo pakopos ar tvarka;
 *  - biudžeto dalijimo taisyklės;
 *  - `contextPackSchema` laukų prasmė (naujas laukas su default'u parsina SENĄ įrašą tyliai —
 *    būtent taip `spec_fragment_truncated` būtų atrodęs kaip „nenukirpta").
 *
 * NEreikia kelti dėl `execution-context.md` renderio: jis kiekvieno hit'o metu generuojamas
 * IŠ NAUJO iš kešuoto pack'o, tad render'io pakeitimai pasiekia ir senus įrašus.
 *
 * Istorija:
 *  1 — pradinė (etalono paritetas).
 *  2 — 2026-08-21 RAG auditas, pirmoji banga: antraščių sekcijos su poskyriais, Markdown rūšis
 *      pagal galutinį kelią, projekto ribų vartas, kirpimas ties pastraipa,
 *      `spec_fragment_truncated` laukas, penkios reitingavimo pakopos sutrauktos į tris.
 *  3 — tos pačios dienos ANTROJI banga, po 2 kėlimo. Kelti reikėjo dar kartą, nes pasikeitė
 *      pack'o TURINYS, o ne tik kodas aplink jį:
 *        • `allowed_paths` nebekarpomi iki `max_files` — v2 įrašas grąžintų NUKIRPTĄ redagavimo
 *          ribą, t. y. worker'iui melagingai susiaurintą leidimų sąrašą;
 *        • ne-Markdown `#anchor` dabar yra `headingMiss`, tad keičiasi ir pakopa, ir kas
 *          išgyvena biudžetą, ir `spec_fragment_warnings`;
 *        • įrašo forma gavo `spec_dropped_count` ir `code_context_dropped_count` — senas
 *          įrašas juos parsintų kaip 0, t. y. tyliai praneštų „nieko neprarasta".
 *      Nė vieno iš šių pakeitimų `PACK_SEMANTICS_DESCRIPTOR` nepagauna: jie nekeičia jokios
 *      derinimo konstantos. Būtent tam ši versija ir yra RANKINIS kontraktas.
 *  4 — 2026-08-23 RAG auditas: `chunkMarkdownByHeading` tapo fence-aware — `# eilutė` fenced
 *      code bloke nebėra antraštė. Keičiasi antraščių sekcijų ribos (fantominė antraštė
 *      nebekerpa sekcijos) ir atitikimas (fantomas nebegali būti match'as), tad v3 įrašas
 *      grąžintų nukirptą arba ne tą sekciją. Grynai loginis pakeitimas — deskriptorius jo
 *      nemato.
 *  5 — 2026-08-23 daugiakalbis code-index. `codeIndexVersion` pakelta 2.1.0 → 3.2.0: indeksas ėmė
 *      duoti importus, simbolius ir grafo briaunas JavaScript, Python, PHP, C# ir .NET failams, o
 *      testų atpažinimas pataisytas. Visa tai keičia `code_context` TURINĮ, bet NEKEIČIA šaltinių
 *      hash'o — tie patys failai, kitas indeksas. Be šio kėlimo v4 įrašas, sudėtas iš skurdesnio
 *      indekso, grįžtų kaip pilnavertis hit'as.
 *
 *      Kartu įvestas STRUKTŪRINIS taisymas: `code_index` deskriptorius nuo šiol yra
 *      `fresh:<indekso versija>:<source_hash>`, o ne tik `fresh:<source_hash>`. Todėl BŪSIMI
 *      indekso kėlimai anuliuos iš jo sudėtus pack'us automatiškai, ir šios versijos kelti dėl
 *      indekso nebereikės. Šis kėlimas lieka dėl jau esamų v4 įrašų, kurie neša senąją
 *      deskriptoriaus formą.
 *  6 — 2026-08-23: antraščių normalizavimas tapo Unicode. Iki tol ne lotyniškos antraštės virsdavo
 *      TUŠČIU raktu, tad `#Интерфейс` sekcijos nerasdavo ir į pack'ą patekdavo VISAS dokumentas;
 *      be to skirtingos antraštės susiliedavo (`Раздел 2` → `2`). Keičiasi ir tai, KAS patenka į
 *      `spec_fragments`, ir `headingMiss` žymos, tad v5 įrašas grąžintų ne tą fragmentą.
 *      Grynai loginis pakeitimas — `PACK_SEMANTICS_DESCRIPTOR` jo nemato.
 *  7 — 2026-08-23 RAG auditas 3: BM25 skaidymas tapo Unicode. Iki tol skirtukas buvo `[^a-z0-9_]`,
 *      tad kirilicos, CJK ir net lietuviški žodžiai subyrėdavo į nieką — užklausa ir tiksliai ją
 *      atitinkantis dokumentas abu gaudavo 0, ir laimėdavo pirmas nesusijęs kandidatas. Keičiasi
 *      kandidatų TVARKA pakopos viduje, tad v6 įrašas grąžintų kitaip surikiuotą pack'ą. Grynai
 *      loginis pakeitimas — `PACK_SEMANTICS_DESCRIPTOR` jo nemato.
 *
 *      Tuo pačiu `rag-policy.json` išimtas iš `CONTEXT_CACHE_POLICY_FILES` (jis neturėjo
 *      skaitytojo, ir šablonas nebesiunčiamas), tad `policy` komponento digest'as pasikeitė ir be
 *      loginio pakeitimo.
 *
 *      To paties audito code-index pakeitimai (`codeIndexVersion` 3.6.0 → 4.0.0) šio kėlimo
 *      NEREIKALAUJA: nuo v5 `code_index` deskriptorius neša indekso versiją ir anuliuoja pats.
 *  8 — 2026-08-24 RAG auditas 4. Keičiasi tai, KAS patenka į pack'ą, ir tai, ką pack'as apie save
 *      SAKO — keliais nepriklausomais keliais, tad viena versija apima juos visus:
 *        • `extractSection` tapo fence-aware. `# komentaras` ```bash bloke nebekerpa sekcijos, o
 *          užduoties šablonas ```text bloke nebepradeda jos. Keičiasi `## Spec source` (ką RAG
 *          apskritai ima), `## Veiksmas` (acceptance criteria IR BM25 užklausos pusė), `## Stop`,
 *          `## Neįtraukta` — t. y. ir įvestis, ir turinys.
 *        • `spec_fragment_warnings` ėmė įvardyti ref'us, numestus graph-first atrankos, ir
 *          taikomi SVARBOS tvarka; kartu pasikeitė ir kiek kitų įspėjimų telpa.
 *        • fragmentų dedup pagal TURINĮ (ne `ref` + turinys), tuščias pjūvis nebelaikomas
 *          fragmentu, tuščios `## Spec source` eilutės nebevalgo kandidatų limito.
 *        • architektūros mazgai atrenkami pagal segmentus, ne plikus substring'us, tad
 *          `architecture_nodes` sudėtis kitokia.
 *      `PACK_SEMANTICS_DESCRIPTOR` gavo `impacted_test_importer_depth`, tad TA konstanta nuo šiol
 *      anuliuoja pati — bet jos įvedimas į deskriptorių pats yra rakto pakeitimas.
 *  9 — 2026-08-24 RAG auditas 5: `parseBacktickChecks` nustojo skaityti fenced blokus. Iki tol
 *      ```` ``` ```` fence ribos pačios atrodė kaip backtick span'ai, tad `## Patikra` su komandų
 *      pavyzdžiu duodavo netikras patikras (`bash\n# pavyzdys`, `-`) IR pamesdavo tikrąją, nes
 *      uždarančio fence backtick'ai susiporuodavo su jos atidarančiuoju. Keičiasi pack'o `checks`
 *      — laukas, kurį renderis worker'iui deklaruoja kaip „must pass" komandas.
 *
 *      Renderio pakeitimai (praradimų bloko prioritetas ir vieta) šio kėlimo NEREIKALAUJA:
 *      `execution-context.md` generuojamas iš naujo kiekvieno hit'o metu.
 * 10 — 2026-08-29, task 089: `code_context` gavo `symbol_hypothetical_src_chars` — kiek SRC
 *      pakopos negavę simboliai būtų kainavę su pilnais source pjūviais. Matuojama surinkimo
 *      metu, kol `sourceSlices` tekstas dar rankose, ir keliauja pack'e BŪTENT tam, kad hit'as
 *      praneštų tą patį skaičių kaip jį pagaminęs miss'as. Be kėlimo v9 įrašas grįžtų kaip
 *      pilnavertis hit'as be lauko, o skaitytojas jo nebuvimą laikytų nuliu — t. y. tyliai
 *      praneštų „SRC pusėje nieko neprarasta". Tai lauko PRASMĖS pakeitimas
 *      `contextPackSchema` bloke, kurio `PACK_SEMANTICS_DESCRIPTOR` nemato.
 * 11 — 2026-09-02, task 138: `domain/policies/agent-selection.ts` `parseAgentBlock` legacy
 *      šaka nebeišskaido prozos sakinio be strėlių į N vaidmenų iš N žodžių (2026-09-01
 *      incidentas 097 dispatch'e — UI grandinė rodė čipus iš sakinio žodžių). Keičiasi
 *      pack'o `agents` lauko TURINYS tam pačiam task tekstui, o `PACK_SEMANTICS_DESCRIPTOR`
 *      to nemato — grynai loginis parse pakeitimas.
 * 12 — 2026-09-02, task 144-a (RAG auditas 7, radinys R2): `spec-phase.ts` `droppedCount`
 *      nebeskaičiuoja `duplicate` numetimų — task'o pakartotas spec ref'as nėra praradimas,
 *      turinys liko pack'e per pirmąjį paminėjimą. `spec_fragment_warnings` eilutė dublikatui
 *      lieka nepakitusi (severity `redundant`, tekstas tas pats) — keičiasi TIK
 *      `spec_dropped_count` skaičius. Be kėlimo v11 įrašas grąžintų DIDESNĮ skaičių tam
 *      pačiam task'ui, nes senas skaičiavimas dublikatus laikė praradimu. Grynai loginis
 *      pakeitimas — pack'o TURINYS kitam tam pačiam task'ui, o `PACK_SEMANTICS_DESCRIPTOR`
 *      to nemato.
 * 13 — 2026-09-03, task 101-c: pack'as gavo `docs_snippets` — neįvardytus kontrolinių dokumentų
 *      gabalus (`discovered-docs.ts`). Naujas šaltinių rinkinys (`discoveredDocsCacheSources`)
 *      dengia tik tuos projektus, kuriuose kontrolinių dokumentų YRA: kai jų nėra, rinkinys
 *      tuščias, `spec` komponentas nepakitęs, ir v12 įrašas atitiktų raktą baitas į baitą.
 *      Toks įrašas grįžtų kaip pilnavertis hit'as be `docs_snippets` lauko — o skaitytojas jo
 *      nebuvimą laikytų „discovery nieko nerado", nors realiai discovery nė nebuvo paleista.
 *      Šaltiniai mato DUOMENIS, versija — kad pats kelias atsirado.
 */
export const CONTEXT_CACHE_VERSION = 13;

// Hash sentinel for an evidence source that does not exist yet. Its later creation
// changes the fingerprint, so a missing spec file cannot be cached away.
export const CONTEXT_CACHE_ABSENT = "absent";

// Code index descriptors.
export const CODE_INDEX_UNUSED = "unused";
export const CODE_INDEX_STALE = "stale";

export const contextCacheSourceKindSchema = z.enum(["task", "source", "spec", "architecture", "policy"]);
export type ContextCacheSourceKind = z.infer<typeof contextCacheSourceKindSchema>;

export const contextCacheSourceSchema = z
  .object({
    kind: contextCacheSourceKindSchema,
    // Repo-relative, forward-slash path of the evidence source.
    path: nonEmptyString,
    // sha256 of the file content, or the `absent` sentinel when the source does not
    // exist yet (its later creation must invalidate the entry just like an edit).
    hash: nonEmptyString,
  })
  .passthrough();
export type ContextCacheSource = z.infer<typeof contextCacheSourceSchema>;

export const contextCacheEntrySchema = z
  .object({
    version: z.number().int().positive(),
    task_id: nonEmptyString,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "fingerprint must be 64 lowercase hex characters"),
    // Per-kind digests of `sources`, so a drift can be attributed to task, source, spec,
    // architecture or policy without diffing the whole list.
    components: z.record(contextCacheSourceKindSchema, nonEmptyString),
    sources: z.array(contextCacheSourceSchema).default([]),
    // Identity of the code index this pack's code_context was derived from:
    // `fresh:<indekso versija>:<source_hash>`, arba `unused`, kai užduočiai kodo konteksto
    // nereikėjo. Versija yra deskriptoriaus DALIS nuo v5 — būtent ji anuliuoja pack'us, sudėtus iš
    // senesnio indekso, kai failai nepasikeitė.
    code_index: nonEmptyString,
    // The encoded context-pack.json content, byte for byte. Deliberately NOT
    // `nonEmptyString`: that schema trims, which would drop the encoded pack's trailing
    // newline and make a cache hit differ from the assembly it replaces.
    context_pack_json: z.string().min(1),
    selected_chars: z.number().int().nonnegative(),
    selected_token_estimate: z.number().int().nonnegative(),
    // Carried so a cache hit reports the same truncation telemetry as the assembly that
    // produced it; it cannot be derived from the pack afterwards.
    dropped_item_count: z.number().int().nonnegative().default(0),
    // Retrieval stadijos praradimai — ta pati priežastis kaip `dropped_item_count`: hit'as
    // privalo pranešti tą pačią telemetriją kaip surinkimas, o iš pack'o to nebeišvesi.
    spec_dropped_count: z.number().int().nonnegative().default(0),
    code_context_dropped_count: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type ContextCacheEntry = z.infer<typeof contextCacheEntrySchema>;
