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

## Spec source
openspec/changes/verqestra-backlog-v1 — eilutė „Uždaryti preflight retry memo ribą: aplinkos pataisymas neturi atrodyti kaip human review kilpa".
HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 (GeoGravity auditas).

## Tikslas
Preflight failure memo neturi senėjimo: kartą kritęs task'as laikomas „jau kritusiu" amžinai (8 įrašai stovi nuo 2026-08-27). Šioje dalyje pridedama TIK gryna amžiaus taisyklė — memo, senesnis nei 24 h nuo `failed_at`, laikomas pasenusiu ir nebedengia naujo bandymo. Turinio hash'o palyginimas lieka nepakeistas.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-guards.ts`
- `src/tests/task-execution-rules.test.ts`

Draudžiama:
- `src/application/task-execution/run-coordinator.ts`
- `src/composition/loop/coordinator-optional-adapters.ts`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `run-coordinator-guards.ts`: eksportuok `PREFLIGHT_MEMO_MAX_AGE_MS` (24 h) ir grynas funkcijas `preflightMemoAgeMs(record, nowMs)` bei `preflightMemoExpired(record, nowMs)`; neparsinamas/ateities `failed_at` = pasenęs (fail-open į brangesnę pusę, t. y. pilną preflight'ą).
- `preflightRetryWithoutChange` gauna papildomą `nowMs` lauką `expected` objekte ir grąžina `false`, kai `preflightMemoExpired` yra `true`; hash/task_id/failure_class sąlygos nekeičiamos.
- `src/tests/task-execution-rules.test.ts`: pridėk atvejus — šviežias memo dengia, 25 h memo nebedengia, sugadintas `failed_at` nedengia, pakitęs hash nedengia ir toliau.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok ir klausk, jei taisyklės pakeitimas reikalautų liesti `run-coordinator.ts` ar port'ų kontraktą.

## Neįtraukta
Lazy trynimas ir `PREFLIGHT MEMO EXPIRED` log eilutė koordinatoriuje (kita dalis). Retry limitų keitimas. Worktree kopijų valymas (079). Memo diagnostikos praturtinimas (080).
