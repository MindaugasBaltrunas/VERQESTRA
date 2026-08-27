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
- `AG/openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/spec.md` (`compact_dsl` poros pratekinimas iš `compact-dsl/render.ts`)

## Tikslas
`render.ts` jau skaičiuoja porą `ir_chars`/`dsl_chars` per `renderCompactWorkerDsl(...).stats`, o `metrics.ts` jau turi laukus `dslIrChars`/`dslCompiledChars`. Trūksta tik shadow-render žingsnio `persist.ts`, kuris šią porą paverčia `context-size.jsonl` įrašu.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/compact-dsl/render.ts`
- `src/application/context-pack/assemble/persist.ts`
- `src/tests/characterization-compact-dsl.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/interfaces/**`
- `ui-app/src/**`

## Veiksmas
- `persist.ts`: pridėti shadow-render žingsnį, analogišką esamam `shadowCompiledPromptBody`/`shadowCompileWorkerTaskIr` fail-closed pattern'ui — iškviesti `renderCompactWorkerDsl` su jau turimu `workerTaskIr` try/catch bloke (be `compact_dsl` vėliavos tikrinimo), ir perduoti `stats.ir_chars`/`stats.dsl_chars` į `buildContextSizeMetrics` kaip `dslIrChars`/`dslCompiledChars` (naudoti tuos naujus laukus, NE `irJsonChars`/`compiledTaskChars`).
- Jei `render.ts` reikia smulkaus pakeitimo, kad pora būtų patogiai prieinama iš išorės — daryti minimaliai, negrąžinant renderinamo DSL dokumento turinio pakeitimo.
- Patikrinti, kad `render.ts` NEIMPORTUOJA `persist.ts` (ciklo importų grafe negalima).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei pratekinimas reikalautų pakeisti realiai renderinamą DSL dokumentą arba sukurtų ciklą importų grafe.

## Neįtraukta
- `bash_output_digest`, `symbol_slices`, `dispatch_tool_schema` rašytojai.
- `decideCompression` verdiktas ir `ui-app` vertimai.
- `compact_dsl` vėliavos įjungimas.
