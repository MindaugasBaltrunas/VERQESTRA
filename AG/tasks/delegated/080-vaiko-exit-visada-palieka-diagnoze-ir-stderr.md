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
Nenulinis vaiko exit VISADA palieka diagnozę orchestrator log'e. Dabar `runChild` (`src/composition/loop/command.ts:226`) rašo uodegas tik jei jos netuščios — 2026-08-29 GeoGravity audite 17 iš 35 `WAVE SLOT CHILD EXIT` liko be jokios priežasties. Reikia: kai stderr tuščias — `--- child stderr: EMPTY ---` + stdout uodega; visada — `child exit context: code=<n> duration=<ms>` (`signal` pridedamas tik jei `run` rezultatas jį jau turi, porto kontrakto NEkeisti); kai nesurinkta niekas — atskira grep'inama eilutė `CHILD EXIT SILENT: <worker> <task>`.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas (keičiamas source).

## Failai
Leidžiama:
- `src/composition/loop/child-exit-diagnostics.ts`
- `src/composition/loop/command.ts`
- `src/tests/composition-loop-child-exit.test.ts`

Draudžiama:
- `src/application/**`
- `src/infrastructure/**`
- `src/interfaces/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujame `child-exit-diagnostics.ts` iškelk gryną formatuotoją: iš `{ code, stdout, stderr, durationMs, workerId, taskId }` grąžina log eilutę su uodegomis (4000 simbolių riba kaip dabar), EMPTY žyma, exit kontekstu ir SILENT eilute. `command.ts` jau 414 eil. iš 500 — logika ten neinlaininama.
- `command.ts` `runChild`: išmatuok trukmę apie `run(...)` ir kviesk formatuotoją vietoj esamo `tailOf` bloko; elgesys su netuščiu stderr nesikeičia.
- Tester: keturi atvejai — stderr yra; stderr tuščias, stdout yra; abu tušti (SILENT); exit 0 (jokio bloko).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei tektų keisti `run` porto kontraktą arba liesti `src/application/**`.

## Neįtraukta
Uodegų saugojimas į `vq/logs/slots/*.log` (kita užduotis). Gedimų priežasčių taisymas (078/079). Log rotacija (075). UI atvaizdavimas (065).
