## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/context-pack/assemble/assemble.ts` kešo šaltinių rinkime
(`cacheSources`, ~157-169 eil.) `withCodeGraph` reikšmė patenka į
`computeContextCacheKey` įėjimą (pvz. sintetinis `ContextCacheSource` įrašas su
grafo režimo hash'u) IR `src/tests/context-pack-cache-bypass.test.ts` (arba
kitas cache testas) turi patikrą, kad tas pats taskas su ir be
`--with-code-graph` NEgauna to paties cache įrašo — ALREADY_IMPLEMENTED:
cituok šaltinio pridėjimo eilutes ir testo assert'us kaip įrodymą.

## Tikslas
Context cache raktas ignoruoja `--with-code-graph` režimą (patikrinta
2026-09-01, `src/application/context-pack/assemble/assemble.ts`): 83 eil.
`const withCodeGraph = args.includes("--with-code-graph")`, bet 157-169 eil.
`cacheSources` renkami tik iš `cache.collectSources({ taskPath, taskText,
targets, specSources })` + `contextCompressionCacheSources(...)` — `withCodeGraph`
į `computeContextCacheKey` nepatenka NIEKUR. Tuo tarpu 220-222 eil. pack'o
`code_context` turinys nuo flag'o priklauso tiesiogiai
(`gatherCodeContextCandidates` vs `autoGatherCodeContextCandidates`), o cache
lookup (170-191 eil.) vyksta PRIEŠ šį pasirinkimą. Operatoriaus reprodukcija
(2026-09-01): miss → hit → bypass; hit pakete `code_context` nebuvo, o su tuo
pačiu `--with-code-graph` ir `--no-context-cache` — atsirado. Tai pažeidžia
CLAUDE.md kontraktą „Pack'o semantika ir kešas": viskas, kas veikia sukurto
pack'o turinį, privalo anuliuoti kešą. Sprendimo kryptis — grafo režimą įdėti į
raktą kaip šaltinio įrašą pagal esamą `contextCompressionCacheSources` pavyzdį
(derived hash, ne baitai — žr. `compression-cache-sources.ts` 9-17 eil.
paaiškinimą). Alternatyva „dėti flag'ą į `PACK_SEMANTICS_DESCRIPTOR`" atmesta:
deskriptorius yra kompiliavimo meto KONSTANTŲ atspaudas
(`context-cache-key.ts:50-64`), o čia — per-kvietimo reikšmė.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/context-pack/context-cache-key.ts` (jei sintetinio šaltinio
  helper'is dedamas čia, o ne assemble faile)
- `src/application/context-pack/context-cache-model.ts` (TIK
  `CONTEXT_CACHE_VERSION` konstanta, jei nusprendžiama kelti)
- `src/tests/context-pack-cache-bypass.test.ts` (regresija: režimai nesidalija
  įrašu; jei testas natūraliau gula kitame esamame cache teste — tas failas
  vietoje šio, įrašyti į ataskaitą)
- `src/tests/context-pack-guards.test.ts` (rakto kontrakto testas, jei keičiasi
  `context-cache-key.ts`)

Draudžiama:
- `src/application/context-pack/assemble/gather.ts` (kandidatų surinkimo
  logika teisinga — keičiasi tik rakto sudėtis)
- `src/application/context-pack/compression-cache-sources.ts` (pavyzdys
  skaitymui, ne keitimui)
- `src/infrastructure/persistence/context-cache-store.ts` (saugyklos
  lookup/save kontraktas nekeičiamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/application/context-pack/assemble/assemble.ts` (157-169 eil.): į
  `cacheSources` pridėti grafo režimo įrašą, kad `withCodeGraph=true` ir
  `withCodeGraph=false` duotų skirtingus `computeContextCacheKey` fingerprint'us.
  Forma — sintetinis `ContextCacheSource` (kind iš esamų
  `CONTEXT_CACHE_SOURCE_KINDS`, pseudo-path, iš režimo išvestas hash), pagal
  `contextCompressionArrestCacheSource` pavyzdį
  (`compression-cache-sources.ts:62-72`).
- Apsvarstyti ir ataskaitoje UŽFIKSUOTI sprendimą dėl `CONTEXT_CACHE_VERSION`
  (`context-cache-model.ts:107`, dabar 10) kėlimo: naujas rakto komponentas
  keičia visus fingerprint'us, tad seni įrašai natūraliai taps miss — jei dėl
  to kėlimas nereikalingas, tai įrašyti kaip pagrįstą sprendimą, ne nutylėti.
- Testų lūkestis: tas pats taskas, tie patys šaltiniai — (1) surinkimas be
  flag'o duoda miss → save; (2) pakartotinis surinkimas SU `--with-code-graph`
  gauna miss (ne hit); (3) pakartojimas tuo pačiu režimu gauna hit. Esami
  bypass testai (`context-pack-cache-bypass.test.ts:84,103`) lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad sprendimui
reikia keisti `ContextCacheSource` tipo formą ar saugyklos (`lookup`/`save`)
kontraktą — tai kontrakto keitimas už šio task'o ribų.

## Neįtraukta
- `gatherCodeContextCandidates`/`autoGatherCodeContextCandidates` elgesio
  keitimai — kandidatų surinkimas teisingas, defektas tik rakto sudėtyje.
- Kešo saugyklos evict/capacity politika
  (`src/infrastructure/persistence/context-cache-store.ts`) — neliečiama.
- Kitų per-kvietimo CLI flag'ų (pvz. `--no-context-cache`) auditas dėl
  panašių spragų — jei vykdytojas tokių pastebės, fiksuoti ataskaitoje kaip
  kandidatą atskiram task'ui, ne taisyti čia.
