## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 — operatoriaus sprendimas variantas A: „matuoti hipotetinį SRC per pack lauką su CONTEXT_CACHE_VERSION kėlimu"

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Rašytojo pusė: SIG režimu surinkti simboliai pack'e turi nešti HIPOTETINĮ SRC dydį (kiek tie patys simboliai kainuotų SRC tier'e), išmatuotą gather metu, kai `candidates.sourceSlices` tekstas dar rankose — be papildomo source I/O.

Dabar to nėra: `applyCodeContextTiers` numeta SIG simbolio source tekstą, tad `measureSymbolTierChars` (`src/application/context-pack/assemble/tiers.ts:127`) persist metu mato tik `signature`. Riba aprašyta tiers.ts komentare ~109–126.

Naujas laukas keičia pack'o turinį → PRIVALOMA pakelti `CONTEXT_CACHE_VERSION` (`src/application/context-pack/context-cache-model.ts:100`, dabar 9) į 10. Nepakėlus, senas įrašas be lauko grįžtų kaip hit ir tyliai anuliuotų pataisą (CLAUDE.md pack'o semantikos taisyklė).

Šiame task'e persist.ts NEKEIČIAMAS — telemetrijos rašytojo pusė yra atskiras sekantis task'as. Laukas optional: seni ir SRC režimo pack'ai jo neturi, elgesys nesikeičia.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/context-pack-schema.ts`
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/context-pack/context-cache-model.ts`
- `src/tests/context-pack-assemble.test.ts`
- `src/tests/context-pack-guards.test.ts`
- `src/tests/context-pack-code-index-identity.test.ts`
- `src/tests/fixtures/characterization/context-pack-assembly.json`

Draudžiama:
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/metrics.ts`
- `src/interfaces/http/ui-compression-view.ts`
- `src/infrastructure/persistence/context-cache-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: parinkti optional lauko formą `contextPackCodeContextSchema` bloke (`context-pack-schema.ts`, ~eil. 72) — agregatas ar per-simbolį; sąlyga: laukas užpildomas TIK miss kelyje surinkimo metu, kad hit'as jį grąžintų iš `context_pack_json` be jokio šakojimosi skaitytojo pusėje.
- Coder: išmatuoti hipotetinį SRC `applyCodeContextTiers` viduje (`tiers.ts:22`) arba iškart po jo kvietimo (`assemble.ts:348`) ir įrašyti į pack'ą PRIEŠ encode; pakelti `CONTEXT_CACHE_VERSION` į 10 ir atnaujinti abu literal priminimo testus (`context-pack-guards.test.ts` ~194, `context-pack-code-index-identity.test.ts` ~54); atnaujinti tiers.ts ~109–126 komentarą, kad riba nebegalioja (sprendimas priimtas, laukas keliauja per pack'ą).
- Tester: SIG režimo pack'as turi lauką ir jo reikšmė >= to paties simbolių rinkinio SIG dydžio; SRC režimo ir `symbol_slices`-off pack'ai lauko neturi ir jų projekcija nepakitusi; senas cache įrašas su version 9 po kėlimo duoda miss, ne hit.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai `pnpm build` ir `pnpm test` žali. Sustok ir klausk, jei: reikėtų keisti `persist.ts`, `metrics.ts` ar cache entry formą; jei naujam laukui prireiktų papildomo source skaitymo (tai atmesta alternatyva); jei characterization fixture regeneracija keistų projekcijas, nesusijusias su nauju lauku; jei testą reikėtų susilpninti, kad praeitų.

## Neįtraukta
- `persist.ts` telemetrijos skaitymas iš pack lauko ir hit/miss identiškumo testai — sekantis task'as.
- `gather.ts` — jei matavimui jo prireiktų, sustok ir pranešk (nėra leidžiamuose keliuose).
- UI pora `ui-compression-view.ts:265` — 087-a-02 scope, pradės matuotis be UI pakeitimų.
