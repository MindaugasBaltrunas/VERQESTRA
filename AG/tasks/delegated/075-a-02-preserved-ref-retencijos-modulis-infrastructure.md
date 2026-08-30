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
AG/openspec/changes/verqestra-backlog-v1
## Tikslas
Sukurti gryną preserved-ref retencijos modulį, kuris nustato pasenusius `refs/verqestra/preserved/<commit>` ref'us ir juos pašalina kartu su atitinkamu `.json` metaduomenų failu. Pirma atlik Žingsnis 0: jei retencijos/trynimo mechanizmas jau egzistuoja, sustok ir raportuok ALREADY_IMPLEMENTED su eilučių įrodymu.
## Agentai
readme-guard -> architect -> coder -> reviewer -> tester
## Failai
Leidžiama:
- `src/infrastructure/git/preserved-ref-retention.ts`
- `src/infrastructure/git/preserved-work.ts`
- `src/infrastructure/git/rollback-scope.ts`
- `src/tests/infrastructure-preserved-ref-retention.test.ts`
- `src/tests/infrastructure-git-preserved-work.test.ts`

Draudžiama:
- `src/composition/loop/command.ts`
- `src/interfaces/hooks/log-rotation.ts`
- `dist/**`
- `node_modules/**`
## Veiksmas
- Sukurk `preserved-ref-retention.ts`: ref'as trinamas TIK kai task `done` IR amžius > N parų (numatyta 14, konfigūruojama) IR `.json` įraše nėra `recovered=false`; trynimas loguoja `PRESERVED REF EXPIRED: <ref> task=<id> age=<d>` ir pašalina `.json` kartu su `update-ref -d`.
- Iškelk bendras ref/JSON kelio konstantas iš `rollback-scope.ts` tik tiek, kiek reikia naujam moduliui; nekeisk kito `rollback-scope.ts` elgesio.
- Parašyk testus: done+senas -> trinama su log eilute; jaunas/ne-done/`recovered=false` -> paliekama; nežinoma task būsena -> paliekama.
## Patikra
- `pnpm build`
- `pnpm test`
## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei vartai reikalautų trinti ref'ą, kurio task'o būsenos nustatyti neįmanoma.
## Neįtraukta
Modulio prijungimas prie priežiūros ciklo. Ref'ų trynimas rollback metu. `git gc`/`reflog expire` kvietimai. hooks.log rotacija.
