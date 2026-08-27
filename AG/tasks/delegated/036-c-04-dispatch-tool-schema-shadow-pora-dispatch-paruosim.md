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
- `AG/openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Dispatch paruošimo shadow matavimas“)
- `src/application/context-pack/metrics.ts` — poros laukai `toolSchemaFullChars`/`toolSchemaReducedChars` (pridėti ankstesniame darbe)

## Tikslas
Dispatch paruošimo metu shadow'u išmatuoti pilnos ir sumažintos MCP tool schemos dydžius ir įrašyti porą į `context-size.jsonl`, nekeičiant realiai siunčiamos schemos, kol `dispatch_tool_schema` vėliava išjungta.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/tool-schema.ts`
- `src/application/context-pack/token-usage-log.ts`
- `src/tests/infrastructure-dispatch-flow.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/interfaces/http/ui-compression-view.ts`
- `ui-app/src/**`

## Veiksmas
- Rasti esamą `toolSchema.candidates`/`applied` rinkimo tašką (šiandien žurnale tik režimo eilutė `"applied"|"off"`) ir šalia jo suskaičiuoti pilnos bei sumažintos schemos char dydžius — shadow pora, kaip 032.
- Porą rašyti per `COMPRESSION_METRIC_FIELDS` lentelę į `context-size.jsonl`; nesantis matavimas lieka `undefined`, ne `0`. Jei tikslūs failų keliai skiriasi nuo nurodytų `## Failai`, sustoti ir raportuoti, o ne plėsti scope.
- Testuose padengti: pora rašoma kai vėliava išjungta, o realiai perduodama schema lieka nepakitusi.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei matavimas pastebimai (matuojamai) sulėtintų dispatch kelią arba reikalautų pakeisti siunčiamą schemą.

## Neįtraukta
- `bash_output_digest`, `symbol_slices`, `compact_dsl` rašytojai.
- `decideCompression` verdiktas ir `ui-app` vertimai.
- `dispatch_tool_schema` vėliavos įjungimas.
