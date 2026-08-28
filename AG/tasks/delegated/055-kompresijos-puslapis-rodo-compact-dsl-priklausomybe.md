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
openspec/changes/verqestra-backlog-v1

## Tikslas
`GET /api/compression` view'as tyli apie priklausomybes: kai `compact_dsl=true`, o `worker_task_ir=false`, efektyvus konfigas vėliavą priverstinai išjungia (`src/domain/policies/compression/dependencies.ts:23`), bet view grąžina ją kaip galiojančią. Pridėti serveryje skaičiuojamus laukus, kad UI nieko neperskaičiuotų.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-compression-view.ts` kiekvienai vėliavai jau grąžina `requires` ir `inactive_reason` — ALREADY_IMPLEMENTED, stok ir pranešk.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`
- `src/tests/interfaces-http-compression.test.ts`

Draudžiama:
- `src/domain/policies/compression/dependencies.ts`
- `src/domain/policies/compression/features.ts`
- `src/application/context-pack/effective-compression-policy.ts`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ui-compression-view.ts`: importuok `COMPRESSION_FEATURE_DEPENDENCIES` iš domain ir kiekvienai vėliavai pridėk opcionalų `requires` (reikalaujamų vėliavų sąrašas).
- Toje pačioje vietoje užpildyk opcionalų `inactive_reason` TIK kai deklaruota reikšmė nėra `false`, o bent viena privaloma vėliava efektyviame konfige yra `false`; kitu atveju lauko nebūna (`exactOptionalPropertyTypes` — per sąlyginį spread).
- Testai: `compact_dsl=true` + `worker_task_ir=false` → `inactive_reason` užpildytas; `worker_task_ir=true` → lauko nėra; HTTP testas tikrina, kad laukai pasiekia atsakymą.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei taisymui reikėtų liesti domain priklausomybių lentelę arba silpninti testą.

## Neįtraukta
UI atvaizdavimas (`CompressionPage.tsx`, i18n, CSS) — atskira sekanti užduotis. Numanomas `worker_task_ir` įjungimas (sąmoningai atmestas). `canary` per-task kohortos vertinimas.
