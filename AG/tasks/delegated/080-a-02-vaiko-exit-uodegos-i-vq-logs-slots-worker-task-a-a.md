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
openspec/changes/verqestra-backlog-v1

## Tikslas
Vaiko diagnostika neturi priklausyti nuo orchestrator.log rotacijos. Kai `runChild` (`src/composition/loop/command.ts`) fiksuoja nenulinį vaiko exit, ta pati diagnostika papildomai append'inama į `vq/logs/slots/<worker>-<task>-a<attempt>.log`. Remiasi ankstesne užduotimi, kuri sukūrė `src/composition/loop/child-exit-diagnostics.ts` formatuotoją — naudok jį, netiražuok formatavimo.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas (keičiamas source).

## Failai
Leidžiama:
- `src/composition/loop/child-exit-diagnostics.ts`
- `src/composition/loop/command.ts`
- `src/tests/composition-loop-child-exit-slots-log.test.ts`

Draudžiama:
- `src/application/**`
- `src/infrastructure/**`
- `src/interfaces/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Failo vardą (`<worker>-<task>-a<attempt>.log`, sanitizuotas nuo kelio separatorių) formuok `child-exit-diagnostics.ts` gryna funkcija; rašymą atlik `command.ts` per jau surištą fs/log adapterį, be tiesioginio `node:fs` importo naujame domain kelyje.
- Katalogas `vq/logs/slots` sukuriamas pagal poreikį; įrašas — append, ne overwrite; rašymo klaida nenutraukia slot'o vykdymo (log'inama ir tęsiama).
- Tester: du exit'ai to paties `<worker>-<task>-a<attempt>` sukaupia abu įrašus viename faile; SILENT atvejis irgi patenka į failą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei `command.ts` viršytų 500 eilučių arba tektų keisti `src/application/**`.

## Neįtraukta
Log rotacijos/valymo politika slots kataloge (075). Gedimų priežasčių taisymas (078/079). UI atvaizdavimas (065).
