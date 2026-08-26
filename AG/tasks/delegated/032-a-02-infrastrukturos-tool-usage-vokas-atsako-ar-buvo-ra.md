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
`src/infrastructure/adapters/claude-tool-schema.ts:164`

## Tikslas
`extractDispatchToolUsage` jau surenka panaudotus įrankius, bet niekas negali paklausti „ar vykdytojas apskritai rašė". Reikia to vieno gryno atsakymo, kad diagnozė vėliau galėtų atskirti „nieko nerašė" nuo „atsukta".

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-tool-schema.ts`
- `src/tests/**`

Draudžiama:
- `src/domain/**`
- `src/application/**`
- `src/composition/**`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Pridėk gryną eksportą šalia `hasDispatchToolEvidence`, kuris iš `DispatchToolUsage` grąžina tris būsenas: `"wrote"` (tarp `mainUsed`/`agentUsed` yra rašymo įrankis), `"no-writes"` (pjūvis yra ĮRODYMAS pagal `hasDispatchToolEvidence`, bet rašymo įrankių nėra), `"unknown"` (neparsinta arba nulis įvykių).
- Rašymo įrankių rinkinys aprašomas viena vieta faile ir apima bent `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
- Testai `src/tests/infrastructure-adapters.test.ts`: log'as su `Write` → `"wrote"`; log'as tik su `Read`/`Grep` → `"no-writes"`; neparsinamas arba tuščias log'as → `"unknown"`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti `extractDispatchToolUsage` išvesties formą ar `DISPATCH TOOL USAGE` eilutę — šis task'as tik prideda skaitytoją.

## Neįtraukta
- Port'o ir `verify-task.ts` prijungimas (kitas vaiko task'as).
- Domeno priežasties funkcija (jau atskiras task'as).
