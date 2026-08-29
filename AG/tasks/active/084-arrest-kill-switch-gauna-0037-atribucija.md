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
Arrest kill-switch skaičiuoja canary human-review baigtis BE atribucijos:
`worker-prompt-preparation.ts:110` paduoda žalią `selectCanaryHumanReviewTaskIds(...)`
rezultatą tiesiai į `observeContextCompressionArrest` (:111), tad infrastruktūrinės
baigtys (lease, worktree, evidence gates, preflight) areštuoja kompresijos features.
Prijungti jau egzistuojančią deterministinę atribuciją
(`application/context-pack/arrest-attribution.js`: `attributeCanaryOutcome`,
`selectArrestCountableHumanReviewTaskIds`) interfaces pusėje.
Jei importas ir filtruotas `humanReviewTaskIds` JAU yra — ALREADY_IMPLEMENTED, cituok eilutes.

## Agentai
PRIVALOMA grandinė (be praleidimų): readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
- `src/tests/dead-export-gate.test.ts`
- `src/tests/interfaces-cli-dispatch-runtime.test.ts`

Draudžiama:
- `src/application/context-pack/arrest-attribution.ts`
- `src/application/analytics/compression-cohorts.ts`
- `src/domain/policies/compression/arrest.ts`
- `src/composition/agent/dispatch-adapters.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-prompt-preparation.ts`: praplėsti `PrepareWorkerPromptDeps.readTaskEvents` (eil. 40)
  grąžinamą tipą OPCIONALIAIS baigties laukais (`phase`/`reason`/`exit_code`), kad esami
  `async () => []` stub'ai kompiliuotųsi; composition jau grąžina pilnus objektus.
- Prieš `observeContextCompressionArrest` (eil. ~111): kiekvienam kohortos task id sujungti
  task-events baigties laukus su to task'o context-size įrašu (per esamą `deps.fs` +
  `deps.runtimeRoot`, `readContextSizeMetrics` iš `application/context-pack/metrics.js`),
  `compressionEffect` išvesti kaip analitikoje (`compiled` vs `raw-fallback`), perleisti per
  `attributeCanaryOutcome` ir paduoti tik `selectArrestCountableHumanReviewTaskIds` rezultatą;
  neperskaitomas ar nesantis context-size įrašas NEGRIAUNA dispatch'o (telemetrija, ne vartai).
- `dead-export-gate.test.ts` (~eil. 269): išimti
  `arrest-attribution.ts#selectArrestCountableHumanReviewTaskIds": "FORWARD"` įrašą;
  `interfaces-cli-dispatch-runtime.test.ts` liesti TIK tiek, kiek reikia esamiems atvejams
  suderinti su nauju elgesiu — naujų scenarijų čia nerašyk.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei atribucijai prireiktų naujo
`PrepareWorkerPromptDeps` lauko, kurio `dispatch-adapters.ts` negali patiekti be keitimo —
composition šio task'o scope nėra. Taip pat stop, jei failas artėtų prie 500 eilučių ribos.

## Neįtraukta
Naujų elgsenos testų rašymas (`interfaces-cli-dispatch-runtime.test.ts`) — sekantis task.
Analitikos pusė ir arešto lango logika — jau teisingos, neliečiamos.
Silent-canary skaitiklio lango semantika — task 085.
