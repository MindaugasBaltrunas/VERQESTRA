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

Pastaba (2026-08-28, po 2 bandymo): darbo KODE DAR NĖRA — `src/composition/loop`
neturi nė vienos „preserved" nuorodos (grep patikrinta 19:20). Use case'as
`application/task-execution/preserved-work-review.ts` ir git adapteris
`infrastructure/git/preserved-work.ts` jau egzistuoja — šio task'o darbas yra
juos SURIŠTI composition sluoksnyje. Ankstesnis bėgimas grąžino „checks passed"
be jokio Write/Edit ir buvo pagrįstai atmestas. NEskelbk ALREADY_IMPLEMENTED,
nebent pateiksi konkrečią composition/loop failo eilutę su surišimu. Darbą
atlik Write/Edit įrankiais ŠIAME bėgime.

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 run-coordinator failai legalizuoti — surišimas be koordinatoriaus portų neįmanomas (3 bandymo radinys)

Trečio bandymo darbas IŠSAUGOTAS: `refs/verqestra/preserved/86dc55927c46364891dffdb75d0725c84f485610`
(žr. vq/state/rollback-preserved/063-c-….json, 6 failai). Gali atkurti iš jo
(`git show <ref>:<kelias>`) arba daryti iš naujo — abu keliai legalūs.

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 064-a-02-orphan-reaper-kviecia-registraciju-valyma-po-katal
- 064-b-03-provisioning-pries-git-worktree-add-isvalo-to-pati

## Tikslas
Surišti preserved work review portus su realiais adapteriais loop composition sluoksnyje, kad automatinė išsaugoto darbo peržiūra veiktų gyvame dispatch kelyje.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/preserved-work-adapters.ts`
- `src/composition/loop/command.ts`
- `src/application/task-execution/run-coordinator.ts`
- `src/application/task-execution/run-coordinator-model.ts`
- `src/tests/composition-preserved-work-wiring.test.ts`
- `src/tests/task-execution-coordinator.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/domain/**`
- `src/interfaces/**`

## Veiksmas
- Adapteryje surišk infrastruktūros preserved worktree materializavimą ir komandų paleidimą su application portu; jokios verslo logikos composition sluoksnyje.
- Prijunk adapterį prie `verify-task` kelio loop'o surišime, nekeisdamas kitų dispatch žingsnių.
- Testas: surišimas paduoda realų adapterį ir žalias preserved darbas praeina iki done su `PRESERVED-WORK-RECOVERED`; be adapterio elgesys nekinta.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei prireiktų keisti public CLI kontraktą ar `package.json`.

## Neįtraukta
Timeout'o šaknies sprendimas, preserved ref'ų valymo politika, UI rodymas.
