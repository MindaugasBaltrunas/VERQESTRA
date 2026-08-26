# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`src/composition/ui/analytics-adapters.ts` turi perduoti nematuotų celių laukus iš `suite-report-view` į UI atsaką, o kontraktas per HTTP ribą turi būti pin'inamas testu — `as` cast'as nėra kontraktas.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `src/composition/ui/analytics-adapters.ts`
- `src/tests/`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`
- `AG/benchmark/**`
- `ui-app/**`
- `src/application/**`

## Veiksmas
- Adapteryje perduoti režimo nematuotų celių laukus (bandyta / atmesta / priežasčių santrauka) be `as` cast'o per ribą.
- Pridėti arba išplėsti kontrakto testą `src/tests/` pagal `composition-ui-dashboard-contract.test.ts` šabloną, kad laukai būtų pin'inti iš abiejų pusių.
- Senas raportas be šių laukų turi eiti pro adapterį be klaidos (absent / 0).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink iš karto, kai abi patikros žalios. Sustok, jei kontrakto pin'as reikalautų keisti public API formą ar `sampleCount` prasmę.

## Neįtraukta
- `ui-app` tipai ir BenchmarkPage (kitas darbas).
- `AG/benchmark` raporto modelis ir `suite-report-view` schema (atlikti ankstesniuose darbuose).
