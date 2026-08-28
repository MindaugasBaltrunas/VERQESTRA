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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Prijungti preserved work review verdiktą prie `verify-task` sprendimo: žalias išsaugotas darbas užbaigiamas kaip done su `PRESERVED-WORK-RECOVERED` žyma, raudonas — human-review su patikrų išvestimi ir preserved ref nuoroda.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/tests/task-execution-run.test.ts`
- `src/tests/task-execution-verify-preserved.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/infrastructure/**`
- `src/composition/**`

## Veiksmas
- `verify-task.ts` vietoje, kur iš `ROLLBACK PRESERVED` eilutės ištraukiamas `ref=`, iškviesk review use-case ir sprendimą priimk pagal jo verdiktą; portas paduodamas per parametrus (jei jo nėra — elgesys lieka kaip dabar).
- Žalias kelias grąžina done su `PRESERVED-WORK-RECOVERED` žyma commit žinutėje; raudonas — human-review priežastis papildoma patikrų uodega ir ref nuoroda.
- Testai: žalias preserved darbas → done su žyma; raudonas → human-review su uodega; preserved ref be turinio → human-review kaip dabar. Failai ≤ 500 eilučių — jei `verify-task.ts` peraugtų, iškelk šaką į atskirą modulį.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei esamą preserved elgesį reikėtų keisti taip, kad senas testas silpnėtų.

## Neįtraukta
Composition surišimas — sekanti užduotis.
