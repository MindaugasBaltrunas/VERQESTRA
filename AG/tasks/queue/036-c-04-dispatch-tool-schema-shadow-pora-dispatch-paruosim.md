# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Dispatch paruošimo shadow matavimas“)
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
