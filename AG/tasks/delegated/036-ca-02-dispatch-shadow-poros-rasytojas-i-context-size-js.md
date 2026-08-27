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
- `AG/openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/spec.md` ("Dispatch paruošimo shadow matavimas")

## Tikslas
finalizeDispatch metu shadow porą įrašyti į vq/logs/context-size.jsonl kaip tool_schema_full_chars/tool_schema_reduced_chars, nekeičiant esamų dispatch artefaktų ar token-usage metaduomenų.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `src/tests/infrastructure-dispatch-flow.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/infrastructure/adapters/claude-dispatch-delivery.ts`
- `src/interfaces/http/ui-compression-view.ts`

## Veiksmas
- finalizeDispatch pabaigoje, jei input.toolSchema.shadow apibrėžtas, sukurk buildContextSizeMetrics įrašą (taskId=input.taskId, toolSchemaFullChars=shadow.fullChars, toolSchemaReducedChars=shadow.reducedChars, likę dydžio laukai 0) ir appendink į contextSizeMetricsLogPath(input.runtimeRoot) per fs portą; apgaubk try/catch, kad telemetrijos gedimas nesulaužytų finalize (etalonas: src/interfaces/hooks/post-hooks.ts eilutės 151-166).
- Jei input.toolSchema.shadow neapibrėžtas, eilutės nerašyk.
- Nekeisk dispatch_tool_schema/disallowed_tools reikšmių token-usage metaduomenyse.

## Patikra
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`

## Stop
Pirma patikrink, ar jau įgyvendinta: jei eilutė jau rašoma, NEDARYK pakeitimų ir ataskaitą pradėk eilute ALREADY_IMPLEMENTED: <failai/eilutės>. Commit'ink tik kai visos patikros žalios. Sustok, jei rašymas reikalautų keisti siunčiamą schemą.

## Neįtraukta
- bash_output_digest, symbol_slices, compact_dsl rašytojai.
- decideCompression verdiktas, FEATURE_PAIR_SELECTORS ir ui-app vertimai.
- dispatch_tool_schema vėliavos įjungimas.
