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
065-b-03 buvo pažymėtas `done`, bet OverviewPanel realiai niekada negavo w2 signalų — dabar tai generinis `{metrics}` renderis. Šioje dalyje pridedami DU signalai, kurie yra 100% išvedami iš jau turimų UI duomenų, nekeičiant nei serverio, nei view-model sluoksnio.

Jei `ui-app/src/view/components/OverviewPanel.tsx` jau importuoja `SlotProgressView` arba `WorkerControlView` IR turi šaką, kuri lygina `workerId` su literalu `"w2"` (ne komentare), IR egzistuoja `OverviewPanel.test.tsx` su w2 testu — ALREADY_IMPLEMENTED: nurodyk `failas:eilutė` abiem failams ir sustok.

## Agentai
PRIVALOMA grandinė (readme-guard pirmas): readme-guard -> coder -> reviewer -> i18n -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/OverviewPanel.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `DashboardPage.tsx`: `<OverviewPanel />` kvietimui (~195 eil.) paduoti `slotProgress={slotProgress}` (jau skaičiuojamas ~72-87 eil.) ir `workerControl={dashboard.workerControl}`. Jokio naujo skaičiavimo ar runtime importo iš `model/**` — tik type-only.
- `OverviewPanel.tsx`: praplėsti `Props` laukais `slotProgress?: SlotProgressView[]` ir `workerControl?: WorkerControlView` (type-only importai). Viduje suformuoti iki 2 papildomų `OverviewMetric`-formos įrašų ir sujungti su `metrics` prieš renderį: (1) w2 gyvas — `slotProgress?.find((s) => s.workerId === "w2")`; jei rastas ir `taskId !== null`, reikšmė `` `${taskId} (${Math.round(elapsedMs / 60000)}m)` `` kai `elapsedMs !== null`, kitaip vien `taskId`; kitu atveju eilutė NErodoma. (2) bangos režimas — jei `workerControl?.lastWaveKnown`, reikšmė `"sequential"` kai `grantedOf <= 1`, kitaip `` `parallel ${granted}/${grantedOf}` ``; kitu atveju NErodoma.
- Naujoms etiketėms pridėti EN+LT raktų poras `I18nContext.tsx`; `dashboard.css` keisti TIK jei atsiranda nauja `className` (jei pakanka `.metric`/`.metric-label`/`.metric-value` — nekeisti ir pažymėti ataskaitoje). Parašyti `OverviewPanel.test.tsx`: w2 su `elapsedMs`, w2 be `elapsedMs`, w2 nėra (eilutės nėra), `lastWaveKnown` su `grantedOf=1` ir su `grantedOf=2`.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`
- `pnpm test`

Commit tik kai visos trys žalios.

## Stop
Sustok ir klausk, jei: reikėtų keisti `ui-app/src/model/**` ar `src/**`, kad signalas pasiektų UI; `SlotProgressView`/`WorkerControlView` laukai (`workerId`, `taskId`, `elapsedMs`, `lastWaveKnown`, `granted`, `grantedOf`) realiai vadinasi kitaip; arba testas raudonas dėl duomenų kontrakto, o ne dėl renderio.

## Neįtraukta
- Trečias signalas (paskutinė w2 nesėkmė iš `lastError`) — atskira, sekanti užduotis.
- `DashboardPage.test.tsx` nekuriamas: props prijungimą dengia `OverviewPanel.test.tsx`.
- Bet koks `merged` / `parked` / `child exit` semantikos įvedimas.
