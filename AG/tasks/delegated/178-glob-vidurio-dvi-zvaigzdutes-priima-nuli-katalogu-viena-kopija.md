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
Jei `src/domain/tasks/allowed-paths.ts` `wildcardPatternMatches` `**` po kurio eina `/` verčia į
`(?:.*/)?` (arba lygiavertę formą, kuriai `matchesAllowedPath("ui-app/src/App.tsx", "ui-app/src/**/*.tsx")`
grąžina `true`), o `src/domain/scheduling/scope-lock-rules.ts` NEBETURI savo `wildcardPatternMatches`
kopijos ir importuoja ją iš `../tasks/allowed-paths.js` — ALREADY_IMPLEMENTED: cituok regex šaltinį
ir importo eilutę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, D1, patikrinta ✓):
`src/domain/tasks/allowed-paths.ts:197-203` `wildcardPatternMatches` verčia `**` į `.*`, bet literalūs
`/` aplink lieka, tad `ui-app/src/**/*.tsx` tampa `^ui-app/src/.*/[^/]*\.tsx$` — `ui-app/src/App.tsx`
(vienas `/` tarp `src` ir failo) NEATITINKA. Glob semantikoje `**/` reiškia nulį ar daugiau katalogų.
Task'ai 026 ir 068 (`AG/tasks/done`) deklaravo būtent `ui-app/src/**/*.tsx`; toks pakeitimas
`src/domain/diagnosis/dispositions.ts` kelyje virsta „changed files outside allowed paths" →
human-review/rollback. Tas pats `src/**/*.ts` (`src/tests/scheduling-conflict-detector.test.ts:18`)
vs `src/index.ts`. Testai pina tik `src/**` ir `**/x.ts` formas, ne vidurinę.
Antra kopija: `src/domain/scheduling/scope-lock-rules.ts:130-136` yra pažodinis dublikatas su ta
pačia klaida, nors `allowed-paths.ts:171-176` antraštė teigia „čia kopija yra VIENA". Dvi kopijos
dreifuos atskirai — todėl kartu su pataisa antra kopija trinama, o `scope-lock-rules` importuoja
kanoninę funkciją iš `allowed-paths`. Atmesta alternatyva „pataisyti abi vietoje": ji palieka
dreifo šaltinį, dėl kurio ir prireikė šio task'o.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/allowed-paths.ts` (`wildcardPatternMatches` 197-203 eil.: `**/` → `(?:.*/)?`; eksportuoti funkciją)
- `src/domain/scheduling/scope-lock-rules.ts` (130-136 eil. kopija trinama, importas iš `../tasks/allowed-paths.js`)
- `src/tests/domain-tasks.test.ts`
- `src/tests/scope-lock-rules.test.ts`
- `src/tests/scheduling-conflict-detector.test.ts`
- `src/tests/characterization-scheduling.test.ts`

Draudžiama:
- `src/domain/diagnosis/dispositions.ts` (vartotojas, nekinta)
- `src/application/scheduling/conflict-detector.ts` (kvietėjas, nekinta — komentaras 152 eil. lieka teisingas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `allowed-paths.ts` `wildcardPatternMatches`: šablono dalį `**/` (dviguba žvaigždutė, po kurios seka
  `/`) versti į `(?:.*/)?`; vienišą `**` (segmento gale ar sufikse) — kaip iki šiol `.*`; `*` — `[^/]*`.
  Funkciją eksportuoti (`export function wildcardPatternMatches`) ir antraštės 171-176 eil. teiginį
  „kopija yra VIENA" palikti teisingu.
- `scope-lock-rules.ts`: ištrinti lokalią `wildcardPatternMatches` (130-136 eil.), importuoti iš
  `../tasks/allowed-paths.js` (domain → domain; `allowed-paths` neimportuoja `scheduling`, ciklo nėra).
  `globMatches` ir 173-187 eil. logika („atitiktis privalo prasidėti literaliu prefiksu") lieka —
  patikrinti, kad `globTailSegments` samprotavimas apie `**` galioja ir naujai formai.
- Testai `domain-tasks.test.ts`: `ui-app/src/**/*.tsx` atitinka ir `ui-app/src/App.tsx`, ir
  `ui-app/src/view/panels/X.tsx`; `src/**/*.ts` atitinka `src/index.ts`; `a/**/b.ts` NEatitinka
  `a/xb.ts`; senos formos (`src/**`, `**/x.ts`, `src/*.ts`) — kaip iki šiol.
- Testai `scope-lock-rules.test.ts`: `scopeCovers`/`scopesConflict` su vidurio `**/` šablonu duoda tą patį
  rezultatą kaip `matchesAllowedPath` (case-insensitive lyginimas išlieka); esami
  `scheduling-conflict-detector` ir `characterization-scheduling` testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `scope-lock-rules.ts` prefikso samprotavimas
(173-187 eil.) su nauja `(?:.*/)?` forma duoda kitokį `scopesConflict` verdiktą esamiems testams —
tada reikia operatoriaus sprendimo, kuri semantika (lock vs diagnozė) yra pirminė.

## Neįtraukta
- `preflight-rules.ts` broad-scope regex suvienodinimas su `matchesAllowedPath` — task 183.
- `etalonas-rules.ts` `isWildcardPath` (trečias wildcard apibrėžimas) — task 181.
- Diagnozės `dispositions.ts` elgesys nekeičiamas — jis jau naudoja `matchesAllowedPath`.
