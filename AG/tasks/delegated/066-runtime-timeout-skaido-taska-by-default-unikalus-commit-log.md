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
`renderTaskPart` kopijuoja tėvo `## Stop` sekciją su tėvo commit-msg keliu į kiekvieną vaiką, todėl visi vienos šeimos subtaskai dalinasi vienu `logs/tasks/<parent>-commit-msg.md` ir jų write set'ai kertasi — splitter'is pats užblokuoja savo vaikų lygiagretumą (GeoGravity 1150-a/b/c). Kiekvienas vaikas turi gauti UNIKALŲ `logs/tasks/<child-stem>-commit-msg.md` kelią, įrašytą ir į vaiko `## Stop`, ir į vaiko leidžiamų kelių sąrašą.

## Agentai
PRIVALOMA grandinė be praleidimų: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/task-splitting.ts`
- `src/tests/task-execution-rules.test.ts`

Draudžiama:
- `src/domain/**`
- `src/interfaces/**`
- `dist/**`
- `ui-app/**`

## Veiksmas
- `renderTaskPart`: sugeneruoti vaiko `## Stop` tekstą iš tėvo Stop, pakeičiant TIK commit-msg kelią į `logs/tasks/<child-stem>-commit-msg.md` (tėvo formuluotė ir likęs Stop turinys išsaugomi; jei tėvo Stop kelio neturi — kelias pridedamas).
- Tą patį kelią įtraukti į vaiko `## Failai / Leidžiama` sąrašą, kad allowlist ir Stop sutaptų.
- Testai `src/tests/task-execution-rules.test.ts`: `buildTaskSplitPlan` su 3 vaikais duoda 3 skirtingus commit_log kelius, kiekvienas yra to paties vaiko allowlist'e, ir esami statinio skaidymo testai (violations, chunk'ai, spec source) lieka nepakitę.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok iš karto, jei tektų keisti `src/domain/**` arba silpninti esamą splitter'io testą.

## Neįtraukta
Runtime-oversize trigeris po pasikartojančio timeout — atskiras darbas. Diagnozės 'split' verdiktas. Tėvo žymėjimas superseded. LLM-pagrįstas skaidymas.
