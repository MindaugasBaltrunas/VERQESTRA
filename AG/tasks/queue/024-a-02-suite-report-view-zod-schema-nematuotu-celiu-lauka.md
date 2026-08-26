# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`src/application/benchmark/suite-report-view.ts` zod schema turi priimti ir perduoti nematuotų celių laukus (`attemptedCount`, `refusedCount`, atmetimo priežasčių santrauka), kuriuos jau gamina `AG/benchmark` raporto modelis. Be to UI grandinė jų nemato.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `src/application/benchmark/suite-report-view.ts`
- `src/tests/`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`
- `AG/benchmark/**`
- `ui-app/**`
- `src/composition/**`

## Veiksmas
- Į režimo sekcijos zod schemą pridėti adityvius optional laukus nematuotoms celėms (skaičiai + priežasčių santrauka), gerbiant `exactOptionalPropertyTypes` (sąlyginiai spread'ai).
- Užtikrinti, kad senas raportas be šių laukų parse'inasi toliau (absent, ne klaida); `sampleCount` semantika nekeičiama.
- Pridėti testą `src/tests/`, kuris tikrina abu kelius: raportą su naujais laukais ir seną raportą be jų.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink iš karto, kai abi patikros žalios. Sustok, jei paaiškėtų, kad reikia keisti `sampleCount` prasmę arba užantspauduotų baseline dokumentų schemą.

## Neįtraukta
- `src/composition/ui/analytics-adapters.ts` wiring (kitas darbas).
- `ui-app` tipai ir BenchmarkPage (kitas darbas).
- `AG/benchmark` raporto modelis (jau atliktas ankstesniame darbe).
