## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-integration-step.ts` po suliejimo kviečia UI bundle'o
perstatymo portą, kai `ui-app/src` paliestas, o `src/composition/loop/wave-integration-adapters.ts`
tą portą riša su `pnpm --dir ui-app build` — ALREADY_IMPLEMENTED: cituok porto vardą, kvietimą
step'e ir `INTEGRATION UI BUNDLE REBUILT` log eilutę.

## Tikslas
Sveikatos patikra `docs/audits/ui-app-overview-2026-09-02.md` §2026-09-03: `ui-app/dist/assets`
sukurtas 10:09, o `ui-app/src` po to gavo du merge'us (10:25 `group app-ui`, 17:54 task 137 —
in-flight eilutė ir „vykdomas (w1)" ženklelis). Operatorius 137 funkcijos naršyklėje NEMATĖ 5
valandas, nors testai žali ir merge'as `done`. Integracija po `src/` merge'o `dist` perstato
(`wave-integration-step.ts:63-87` → `rebuildDist`, `integrationTouchedOrchestratorSrc`), bet
`ui-app/src` merge'o nemato: `integration-build-impact.ts:30` tikrina tik `ORCHESTRATOR_SRC_PREFIX`.
Dashboard'as staleness'ą rodo (`bundleStalenessFields`, 058), tačiau rodymas nėra perstatymas —
grandis „ui-app merge → `pnpm build:ui`" neegzistuoja. Statika skaitoma iš disko per užklausą, tad
perstatytas bundle'as matomas iš karto be restarto.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/integration-build-impact.ts` (31 eil.; grąžina, KURIE paviršiai paliesti)
- `src/application/scheduling/wave-integration-ports.ts` (portas `rebuildUiBundle`)
- `src/application/scheduling/wave-integration-step.ts` (kvietimas po merge'o, 63-87 eil. šablonas)
- `src/composition/loop/wave-integration-adapters.ts` (adapteris 174-182 eil. šablonas)
- `src/tests/infrastructure-integration-build-impact.test.ts` (numatomas naujas — modulis testų neturi)
- `src/tests/scheduling-wave-integration-ui-bundle.test.ts` (numatomas naujas — `scheduling-wave-integration-coordinator.test.ts` yra 494 eil.)

Draudžiama:
- `src/interfaces/http/ui-rebuild.ts` (POST kelias ir jo įrašas nekinta; komanda ta pati — `UI_REBUILD_ARGS`)
- `src/composition/ui/router-adapters.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts` (494 eil. — esami testai lieka žali nekeisti)
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `integration-build-impact.ts`: vietoje `boolean` grąžinti `{ orchestratorSrc: boolean; uiSrc: boolean }`
  (`ui-app/src/` prefiksas); klaida ar trūkstamas `before` → abu `true` (esama fail-safe kryptis).
  Esamas `integrationTouchedSrc` portas lieka (`orchestratorSrc`), pridedamas `integrationTouchedUiSrc`
  arba vienas struktūrinis — architekto sprendimas, bet kvietėjų semantika `dist`'ui nekinta.
- `wave-integration-ports.ts` + `wave-integration-adapters.ts`: `rebuildUiBundle()` per
  `run(packageManagerExecutable("pnpm"), ["--dir", "ui-app", "build"])` — ta pati komanda kaip
  `ui-rebuild.ts` `UI_REBUILD_COMMAND`/`UI_REBUILD_ARGS` (importuoti konstantas, ne kopijuoti).
- `wave-integration-step.ts`: po sėkmingo `rebuildDistAfterMerge`, kai `uiSrc` paliestas —
  `rebuildUiBundle`; sėkmė → `INTEGRATION UI BUNDLE REBUILT: task=… head=…`; NESĖKMĖ → tik
  `INTEGRATION UI BUNDLE REBUILD FAILED: …` be parko: bundle'as yra stebėjimo paviršius, ne
  vartas, o žalias merge'as dėl vite klaidos į human-review nekeliauja.
- Testai: build-impact — `src/` tik, `ui-app/src/` tik, abu, nė vienas, git klaida → abu `true`;
  step'as — ui-app merge'as kviečia `rebuildUiBundle` ir loguoja, `src` merge'as jo nekviečia,
  nesėkmė neparkuoja ir nesustabdo integracijos.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `ui-app` build'as integracijos metu viršytų
`REBUILD_TIMEOUT_MS` ar reikalautų atskiro timeout'o — tada riba derinama su operatoriumi, ne
tyliai keliama.

## Neįtraukta
- UI serverio API kodo pasenimas (procesas startavo su senu `dist`) — task 162.
- Automatinis rebuild'as po INTERAKTYVAUS commit'o pagrindiniame medyje (ne integracijos kelias).
- `ui.pid` pasenusio įrašo valymas — `ui-lifecycle.ts:131` jį valo kitame starte.
