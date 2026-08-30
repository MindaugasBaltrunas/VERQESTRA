# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/OverviewPanel.tsx` jau importuoja
`SlotProgressView` arba `WorkerControlView` IR turi šaką, kuri lygina
`workerId`/`worker_id` su literalu `"w2"` (ne komentare), IR failas
`ui-app/src/view/components/OverviewPanel.test.tsx` egzistuoja su bent
vienu testu, tikrinančiu w2 signalą — ALREADY_IMPLEMENTED: nurodyk
`failas:eilutė` kaip įrodymą abiem failams.

## Tikslas
065-b-03 audito punktas (dashboard atitikties auditas, 069-d-05 sesija,
2026-08-30) pažymėtas `done/`, bet realiai NIEKADA nebuvo įgyvendintas:
`git log --oneline --follow -- ui-app/src/view/components/OverviewPanel.tsx`
rodo TIK VIENĄ commit'ą visoje istorijoje (`3221525 VQ-601 UZDARYTAS`), o
`OverviewPanel.test.tsx` neegzistuoja (patikrinta Glob'u). Kodas šiuo metu
(`ui-app/src/view/components/OverviewPanel.tsx:6-25`) yra generinis
`{metrics}` renderis — jokio w2-specifinio signalo. `dashboard.overview`
ateina iš `adaptOverview()` (`ui-app/src/model/dashboardViewModel.ts:84-144`),
kuris skaičiuoja TIK globalius laukus (current task, stop status, decision,
claude result, latest activity, stable commit) — nė vienas laukas
neremiasi worker/slot duomenimis. `065-b-03` pačiame turėjo STOP sąlygą
lygiai šitai situacijai: „STOP, jei baigties priežasties (parked/child
exit) serveris per esamus tipus neatiduoda ir reikėtų `src/**` pakeitimo"
— bet vietoj STOP'o failas buvo pažymėtas `done` be jokio pakeitimo kode.

Sprendimas: įgyvendinti tris signalus NENAUDOJANT `src/**` ir
`ui-app/src/model/**` pakeitimų, remiantis TIK jau `DashboardPage.tsx`
turimais duomenimis:
1. „w2: `<task>` (Xm)" kai w2 gyvas — DERIVABLE iš `slotProgress`
   (`SlotProgressView[]`, jau skaičiuojamas `DashboardPage.tsx:72-87` per
   `buildSlotProgressViews`; turi `workerId`, `taskId`, `elapsedMs`).
2. Bangos režimas („sequential" / „parallel 2/2") — DERIVABLE iš
   `dashboard.workerControl` (`WorkerControlView`, jau gaunamas per
   `adaptWorkerControl`, `ui-app/src/model/dashboardViewModel.ts:204-218,
   227-244`): `lastWaveKnown`, `granted`, `grantedOf`. PASTABA: žalio
   serverio `WorkerControlData.lastWave.mode` (`ui-app/src/model/types.ts:
   232-240`) adapteris NEPERDUODA — `WorkerControlView` šio lauko neturi —
   tad režimas skaičiuojamas iš `grantedOf` (`<=1` → sequential, kitaip
   parallel), ne iš originalaus `mode` string'o.
3. Paskutinė w2 baigtis (`merged` / `parked: <priežastis>` / `child exit
   <kodas>`) — TIKSLIAI šios trijų reikšmių semantikos dabartiniai UI
   tipai NEATIDUODA. Artimiausias esamas laukas —
   `SlotProgressView.lastError` (`ts, taskId, reason`, kilęs iš
   `UiWaveSlot.last_failure`, `ui-app/src/model/types.ts:791-795`) — neša
   TIK laisvo teksto priežastį, ne exit kodą ir neskiria „merged" nuo
   „parked". Serverio pusėje yra `src/composition/loop/
   child-exit-diagnostics.ts`, bet jis NĖRA eksponuotas jokiam UI tipui.
   Ši užduotis šio 3-ojo signalo NEIŠGALVOJA tiksliais žodžiais — žr.
   `## Stop`.

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> i18n -> tester.
readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/OverviewPanel.test.tsx` (numatomas naujas —
  patikrinta Glob'u, failo nėra)
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/pages/DashboardPage.test.tsx` (numatomas naujas —
  patikrinta Glob'u, DashboardPage neturi jokio testo failo; jei
  komponento praplėtimui pakanka `OverviewPanel.test.tsx`, šio failo
  nekurti ir įrašyti tai į ataskaitą)
- `ui-app/src/view/styles/dashboard.css` (tik jei atsiranda nauja
  `className` — jei pakanka esamų `.metric`/`.metric-label`/
  `.metric-value`, nekeisti ir pažymėti ataskaitoje)
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ui-app/src/view/pages/DashboardPage.tsx` (~72-87 eil. `slotProgress`
  skaičiavimas jau yra; ~195 eil. `<OverviewPanel metrics={dashboard.overview} />`):
  paduoti papildomus props `slotProgress={slotProgress}` ir
  `workerControl={dashboard.workerControl}` — abu jau egzistuoja
  komponento apimtyje, jokio naujo skaičiavimo ar importo iš `model/**`
  implementacijos nereikia (tik type-only importai).
- `ui-app/src/view/components/OverviewPanel.tsx` (dabar 6-25 eil.):
  praplėsti `Props` laukais `slotProgress?: SlotProgressView[]` (type-only
  importas iš `../../model/slotProgressViewModel`) ir
  `workerControl?: WorkerControlView` (type-only importas iš
  `../../model/dashboardViewModel`). Komponento viduje suskaičiuoti iki 3
  papildomų `OverviewMetric`-formos įrašų ir sujungti su `metrics` prieš
  renderinimą:
  1. Gyvas w2: `slotProgress?.find((s) => s.workerId === "w2")`; jei
     rastas ir `taskId !== null`, reikšmė `` `${taskId} (${Math.round(elapsedMs / 60000)}m)` ``
     kai `elapsedMs !== null`, kitaip be trukmės (`taskId` be skliaustų).
     Jei w2 duomenų nėra arba `taskId === null` — eilutė NErodoma.
  2. Bangos režimas: jei `workerControl?.lastWaveKnown`, reikšmė
     `"sequential"` kai `grantedOf <= 1`, kitaip
     `` `parallel ${granted}/${grantedOf}` ``. Jei `!lastWaveKnown` arba
     `workerControl` nepaduotas — eilutė NErodoma.
  3. Paskutinė w2 nesėkmė (SUMAŽINTA semantika): jei w2 įrašo
     `lastError !== null`, reikšmė `` `${lastError.reason}` `` su etikete,
     kuri NEVARTOJA žodžių „merged"/„parked"/„child exit" (jie implikuotų
     tikslumą, kurio duomenys neturi) — pvz. etiketė „W2 last failure".
     Kai `lastError === null` — eilutė NErodoma (sėkmės/nebuvimo atvejų
     atskirti negalima, tad nerodyti nieko yra sąžiningiau nei spėti).
- Naujiems `t(...)` raktams (naujoms etiketėms, jei jos neturi tinkamo
  esamo rakto) pridėti EN+LT poras `ui-app/src/i18n/I18nContext.tsx`.
- `ui-app/src/view/components/OverviewPanel.test.tsx`: testų atvejai —
  (a) w2 gyvas su `elapsedMs` rodo `taskId (Xm)`; (b) w2 be `elapsedMs`
  rodo `taskId` be trukmės; (c) w2 duomenų nėra → eilutė nerenderinama;
  (d) `grantedOf <= 1` → „sequential"; (e) `grantedOf > 1` → „parallel
  X/Y"; (f) `lastWaveKnown === false` → bangos eilutė nerenderinama;
  (g) `lastError !== null` → rodoma reikšmė LYGI `lastError.reason`, o
  DOM'e NĖRA literalų „merged"/„child exit" (regresinis testas prieš
  išgalvotą semantiką); (h) `lastError === null` → paskutinės nesėkmės
  eilutė nerenderinama.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios ir signalai (1) gyvas w2 su trukme bei
(2) bangos režimas rodomi TIKSLIAI pagal šį veiksmų aprašą. STOP prieš
rašant bet kokį DOM tekstą su literalais „merged", „parked: <priežastis>"
arba „child exit <kodas>" — dabartiniai `SlotProgressView`/`UiWaveSlot`
tipai jų neatiduoda (žr. `## Tikslas`, punktas 3). Jei reviewer arba
tester nusprendžia, kad TIKSLI trijų reikšmių semantika yra privaloma
065-b-03 uždarymui, NErašyk išgalvotų reikšmių — ataskaitoje pasiūlyk
atskirą serverio task'ą (kandidatas: eksponuoti
`src/composition/loop/child-exit-diagnostics.ts` rezultatą per naują
`UiWaveSlot` lauką), o šį punktą palik `## Neįtraukta`.

## Neįtraukta
Tiksli „merged"/„parked: <priežastis>"/„child exit <kodas>" trichotomija
paskutinės w2 baigties signalui — reikalauja naujo serverio lauko (žr.
`## Stop`); ši užduotis rodo tik sąžiningai derivable `lastError.reason`.
`AG/tasks/done/065-b-03-...md` failo neatitikimas su realiu kodu
(task-tracking integritetas — failas guli `done/`, bet darbas niekada
nebuvo atliktas) — TAI NETAISOMA šioje užduotyje, tai atskiro operatoriaus
sprendimo dalykas. `AgentChainProgress` w2 juosta ir „Aktyvus vykdymas"
abu workeriai — jau audituoti 069-d-05 sesijoje, atskira užduotis nereikalinga.
Reviews forma, WavesPanel, LoopControls, SystemStatusHero, RuntimePanel —
ankstesnės 069 šeimos užduotys. Serverio kodas, mobile, scheduling elgsena.
