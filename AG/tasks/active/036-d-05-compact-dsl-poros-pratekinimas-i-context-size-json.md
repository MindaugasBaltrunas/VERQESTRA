# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „`compact_dsl` poros pratekinimas iš `compact-dsl/render.ts`“)
- `src/application/context-pack/metrics.ts` — poros laukai `dslIrChars`/`dslCompiledChars` (pridėti pirmajame darbe)

## Tikslas
Kompiliacijoje jau egzistuojanti pora (IR dydis vs sukompiliuoto DSL dydis) turi pasiekti `context-size.jsonl` — šiandien ji niekur toliau nekeliauja.

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
- Iš `render.ts` grąžinti jau skaičiuojamą porą (IR chars ir compiled chars su DSL statistika) taip, kad `persist.ts` galėtų ją įrašyti per `COMPRESSION_METRIC_FIELDS` į `dslIrChars`/`dslCompiledChars`.
- Naudoti NAUJUS laukus, ne `irJsonChars`/`compiledTaskChars` — pastarieji priklauso `worker_task_ir` porai ir jų perpanaudojimas sumaišytų dvi vėliavas.
- Testuose padengti: pora atsiranda `context-size.jsonl` kai vėliava išjungta, renderinamas DSL dokumentas nepakitęs, `worker_task_ir` pora nepaliesta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei pratekinimas reikalautų pakeisti realiai renderinamą DSL dokumentą arba sukurtų ciklą importų grafe (`render.ts` neturi importuoti `persist.ts`).

## Neįtraukta
- `bash_output_digest`, `symbol_slices`, `dispatch_tool_schema` rašytojai.
- `decideCompression` verdiktas ir `ui-app` vertimai.
- `compact_dsl` vėliavos įjungimas.
