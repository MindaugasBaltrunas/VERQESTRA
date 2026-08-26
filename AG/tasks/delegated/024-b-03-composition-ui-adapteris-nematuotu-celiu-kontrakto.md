## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

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
