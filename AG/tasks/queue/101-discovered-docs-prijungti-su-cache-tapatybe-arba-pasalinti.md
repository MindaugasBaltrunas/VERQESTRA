# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 097-context-cache-raktas-ismato-with-code-graph-rezima

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/code-intelligence/retrieval/discovered-docs.ts`
nebeegzistuoja (Glob) — šalinimo šaka jau įvykdyta; ARBA jei
`src/application/context-pack/assemble/assemble.ts` importuoja
`discoverControlDocCandidates` ir `candidateSet.docsSnippets` (dabar 238 eil.)
nebėra tuščias literalas — prijungimo šaka jau įvykdyta. Abiem atvejais
ALREADY_IMPLEMENTED: cituok Glob/Grep rezultatus ir (prijungimo atveju)
cache šaltinių eilutes kaip įrodymą.

## Tikslas
`src/application/code-intelligence/retrieval/discovered-docs.ts` yra
neprijungtas produkcinis kodas (patikrinta 2026-09-01): vienintelis
importuotojas visame src — `src/tests/context-pack-discovered-docs.test.ts`
(Grep `discovered-docs` → 1 failas; barrel'is
`application/code-intelligence/index.ts` jo NEeksportuoja). Failo antraštė
(31-43 eil.) PATI deklaruoja, kodėl neprijungta: wiring'as reikalauja cache
šaltinių tapatybės — `CONTROL_DOC_ROOTS` turinys turi patekti į cache raktą,
kitaip cache hit tyliai grąžintų pasenusį discovered tekstą — ir tai paliekama
„atskiram task'ui", kuris niekada neatsirado. Prijungimo lizdas atrankos
pusėje JAU suprojektuotas: `GraphFirstContextCandidates.docsSnippets`
(`assemble.ts:238` visada `[]`, `EMPTY_SELECTION.docs_snippets: []` 71 eil.,
atranka `context-selection-policy.ts:133` kibirą apdoroja) — niekas jo
neužpildo. Antras radinys tame pačiame modulyje (aktualus tik prijungimo
šakai): 200 failų riba NEDETERMINISTINĖ — `collectMarkdownFiles` (133-140
eil.) kerta `MAX_DISCOVERED_DOC_FILES` traversal'o tvarka, o
`[...new Set(files)].sort().slice(0, MAX)` (123 eil.) rūšiuoja tik PO to, tad
tam pačiam 201 failo rinkiniui skirtinga `listDirectory` tvarka parenka
skirtingus failus (operatoriaus repro 2026-09-01: viena eiga a000.md, kita
a200.md) — docstring'as 74-75 eil. („tas pats medis visada duoda tą pačią
kandidatų seką") melagingas. Sprendimas: architect ŽINGSNIU NUSPRENDŽIA
„prijungti ar šalinti" (abi šakos specifikuotos žemiau) — trečia alternatyva
„palikti kaip yra dar vienam neapibrėžtam laikotarpiui" atmesta: neprijungtas
kodas su melagingu docstring'u yra būtent ta skola, kurią mirusio kodo
taisyklės liepia arba legalizuoti, arba pašalinti.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/code-intelligence/retrieval/discovered-docs.ts`
  (prijungimo šakoje keičiamas — E2 determinizmas + docstring + antraštės
  atnaujinimas; šalinimo šakoje TRINAMAS)
- `src/tests/context-pack-discovered-docs.test.ts` (prijungimo šakoje —
  determinizmo regresija; šalinimo šakoje TRINAMAS)
- `src/application/context-pack/assemble/assemble.ts` (tik prijungimo šaka:
  wiring + `CONTROL_DOC_ROOTS` cache šaltiniai)
- `src/application/context-pack/discovered-docs-cache-sources.ts` (numatomas
  naujas, tik prijungimo šaka; jei šaltinių rinkimas natūraliau gula
  assemble faile — be naujo failo, įrašyti į ataskaitą)
- `src/application/context-pack/context-cache-model.ts` (tik prijungimo šaka,
  TIK `CONTEXT_CACHE_VERSION`)
- `src/application/context-pack/context-pack-schema.ts` (tik prijungimo šaka,
  jei architektas nusprendžia discovered tekstą nešti pack'e — schema šiandien
  docs lauko NETURI, Grep 2026-09-01)
- `src/application/context-pack/render-execution-context.ts` (tik prijungimo
  šaka, jei naujas pack laukas renderinamas)
- `src/tests/context-pack-assemble.test.ts` (prijungimo šakos wiring
  regresija)

Draudžiama:
- `src/application/code-intelligence/retrieval/markdown-chunks.ts`,
  `ranking.ts`, `spec-fragments.ts` (`chunkMarkdownByHeading`/`bm25Scores`/
  `clipToBoundary` turi kitų kvietėjų — Grep 2026-09-01: spec-fragments,
  ranking, testai — jie LIEKA abiem šakom)
- `src/application/policy-governance/context-selection-policy.ts`
  (`docs_snippets` kibiras jau veikia — nekeičiamas)
- `src/infrastructure/persistence/context-cache-store.ts`
  (`ContextCachePort.collectSources` kontraktas nekeičiamas — šaltiniai
  pridedami kvietėjo pusėje, kaip `contextCompressionCacheSources`)
- `src/tests/context-pack-cache-bypass.test.ts` ir
  `src/tests/context-pack-guards.test.ts` (097 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect, PRIEŠ kodavimą): verdiktas „prijungti ar šalinti" su
  pagrindimu ataskaitoje. Svarstyti: lizdas atrankoje suprojektuotas sąmoningai
  (prijungimo nauda — laisvos formos task'ai be `## Spec source` gauna
  kontrolinių dokumentų kontekstą), PRIEŠ — papildomas FS skaitymas kiekvienam
  surinkimui ir cache rakto išplėtimas penkių šaknų turiniu.
- PRIJUNGIMO ŠAKA: (1) `assemble.ts` — `discoverControlDocCandidates` +
  `rankDiscoveredDocCandidates` + `selectDiscoveredDocs` rezultatai užpildo
  `candidateSet.docsSnippets` (238 eil.) ir keliauja į pack'ą architekto
  pasirinkta forma; (2) `CONTROL_DOC_ROOTS` turinio šaltiniai į `cacheSources`
  (157-169 eil., PO 097 pakeitimų — pagal `compression-cache-sources.ts`
  pavyzdį), kad discovered teksto pasikeitimas anuliuotų cache įrašą;
  (3) `CONTEXT_CACHE_VERSION` kėlimo sprendimas užfiksuojamas ataskaitoje
  (naujas pack turinys = CLAUDE.md „Pack'o semantika ir kešas" taisyklė);
  (4) E2 determinizmas: `listControlDocFiles` renka VISUS kandidatų kelius
  (gylio apsauga `MAX_DISCOVERY_DEPTH` lieka), tada sort, tada
  `slice(0, MAX_DISCOVERED_DOC_FILES)` — failų SKAITYMO IO lubos
  nepažeidžiamos, nes skaitymas vyksta vėliau `discoverControlDocCandidates`;
  (5) docstring 74-75 eil. ir failo antraštės 31-43 eil. „kodėl neprijungta"
  blokas atnaujinami pagal realybę.
- ŠALINIMO ŠAKA: (1) PRIEŠ trynimą persitikrinti Grep'u, kad importuotojas
  tebėra tik testas ir kad `application/code-intelligence/index.ts` bei kiti
  application barrel'iai discovered-docs neeksportuoja (099 pamoka — 2026-09-01
  patikrinta, kad NEeksportuoja, bet sąrašas galėjo pasikeisti); (2) ištrinti
  `discovered-docs.ts` ir `context-pack-discovered-docs.test.ts`;
  (3) `markdown-chunks.ts`/`ranking.ts`/`spec-fragments.ts` NELIESTI — jų
  funkcijos turi kitų kvietėjų.
- Testų lūkestis (prijungimo šaka): (1) surinkimas su discovered dokumentu
  pack'e/atrankoje turi netuščią `docs_snippets`; (2) pakeitus
  `CONTROL_DOC_ROOTS` failo turinį, cache lookup grąžina miss (ne hit su senu
  tekstu); (3) determinizmo regresija — 201 kandidato rinkinys su DVIEM
  skirtingomis `listDirectory` tvarkomis duoda TĄ PAČIĄ atrinktų failų aibę.
  Šalinimo šaka: `pnpm test` žalias be susilpninimų, dead-export ir
  architektūros vartai praeina.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei prijungimo šakoje
paaiškėtų, kad cache tapatybei neužtenka kvietėjo pusės šaltinių ir reikia
keisti `ContextCachePort.collectSources` kontraktą (infrastruktūros sluoksnio
kontrakto keitimas — už ribų), arba jei šalinimo šakoje Grep rastų NAUJĄ
produkcinį importuotoją.

## Neįtraukta
- `rankRetrievalCandidates` pakopų modelio keitimai (`ranking.ts`) —
  discovered srautas sąmoningai atskirtas (failo antraštės dizaino sprendimas),
  ši riba nekvestionuojama.
- Bendras viso repo dokumentų discovery — `CONTROL_DOC_ROOTS` uždaras sąrašas
  lieka; plėtimas būtų atskiras task'as su savo biudžeto analize.
- `--with-code-graph` rakto tapatybė — 097 scope; šis task'as ant jos tik
  statosi (todėl priklausomybė).
- `docs_snippets` limitų derinimas (`context-selection-policy.ts`
  `max_spec_fragments` cap 133 eil.) — jei architektas prijungimo šakoje
  pastebės, kad limitas netinkamas, fiksuoti ataskaitoje kaip kandidatą
  atskiram task'ui, ne keisti čia.
