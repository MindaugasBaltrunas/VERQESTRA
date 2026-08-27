# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Dispatch paruošimo shadow matavimas")
- Prielaida: `DispatchToolSchemaProfile.shadow` pora jau pridėta ankstesnėje užduotyje (`src/infrastructure/adapters/claude-dispatch-delivery.ts`).

## Tikslas
`finalizeDispatch` metu shadow porą įrašyti į `vq/logs/context-size.jsonl` kaip `tool_schema_full_chars`/`tool_schema_reduced_chars`, nekeičiant nė vieno esamo dispatch artefakto ar `token-usage` metaduomens.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `src/tests/infrastructure-dispatch-flow.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/infrastructure/adapters/claude-dispatch-delivery.ts`
- `src/interfaces/http/ui-compression-view.ts`
- `AG/**`
- `vq/**`
- `ui-app/**`

## Veiksmas
- Naudok `buildContextSizeMetrics` ir `contextSizeMetricsLogPath` iš `src/application/context-pack/metrics.ts` kartu su `input.runtimeRoot`/`input.taskId`; etalonas — `src/interfaces/hooks/post-hooks.ts` eilutės 151-166.
- Eilutę rašyk TIK kai `input.toolSchema.shadow` apibrėžtas; užpildyk `toolSchemaFullChars`/`toolSchemaReducedChars`, likusius dydžius `0` kaip esamame Bash shadow rašytojuje. Rašymas best-effort: apgaubk `try/catch`, kad telemetrijos gedimas negalėtų sulaužyti finalize.
- Testai `src/tests/infrastructure-dispatch-flow.test.ts`: su `mode: "off"` + `shadow` pora eilutė atsiranda ir turi abu snake_case laukus; be `shadow` — eilutė nerašoma; `dispatch_tool_schema`, `disallowed_tools` ir `applied` reikšmės lieka nepakitusios.

## Patikra
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`

## Stop
Pirma patikrink, ar jau įgyvendinta: jei eilutė jau rašoma, NEDARYK pakeitimų ir ataskaitą pradėk eilute `ALREADY_IMPLEMENTED: <failai/eilutės>`. Commit'ink tik kai visos patikros žalios. Sustok, jei `DispatchToolSchemaProfile.shadow` lauko dar nėra (ankstesnė užduotis neįvykdyta) arba jei rašymas reikalautų keisti siunčiamą schemą.

## Neįtraukta
- `bash_output_digest`, `symbol_slices`, `compact_dsl` rašytojai.
- `decideCompression` verdiktas, `FEATURE_PAIR_SELECTORS` ir `ui-app` vertimai.
- `dispatch_tool_schema` vėliavos įjungimas.
