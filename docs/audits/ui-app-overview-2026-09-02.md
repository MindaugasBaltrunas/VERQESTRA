# Valdymo centras / Sistemos apžvalga — auditas

Audito laikas: 2026-09-02 (loop'as sukosi gyvai: run `1ab3d8ef…`, w1 = 148-a-02, w2 = 148-b-03)
Tikrinimo būdas: kodo kelias `GET /api/dashboard` → `dashboardViewModel` → `DashboardPage#/`,
SSE kelias `/api/events` → `useAgentActivity` → `AgentChainProgress`/`SlotProgressCard`, sugretintas
su REALIAIS `vq/state` ir `vq/supervisor` failais tuo pačiu metu. Gyvo ekrano naršyklėje
nepamatyta (naršyklės plėtinys neprisijungė), tad vizualiniai ir konsolės defektai neaudituoti.
Verdiktas: **apžvalga sako netiesą apie tai, kas vyksta dabar** — visi pagrindiniai signalai
kilę iš vieno slot'o pirminio medžio artefaktų, o vykdymas seniai persikėlė į worktree bangas.

## Santrauka

Ekranas `#/` („Valdymo centras / Sistemos apžvalga") susideda iš keturių blokų: „Pagrindiniai
signalai" (`OverviewPanel`), „Aktyvus vykdymas" (`AgentChainProgress`), „Ciklo srautų apžvalga"
(`SlotStreamsOverview`) ir „Reikia dėmesio" + „Workflow snapshot". Iš jų teisingai gyvą būseną
rodo tik srautų kortelės: jos maitinamos per-slot'iniais bandymo log'ais iš worktree kopijų
(task 139). Kiti trys blokai skaito globalius pirminio medžio failus, kuriuos worktree vaikai
NERAŠO — jie rašo į savo kopijas. Rezultatas audito momentu:

| Ekrane | Šaltinis | Faktas |
|---|---|---|
| Pasenusi užduoties būsena: `012-a-02 (done)` | `state/current-task-id` (07:18) + `state/current-task-file` (10:25) | 012-a-02 yra `queue`; `done/149-…` yra kito task'o failas |
| Claude rezultatas: `success` | `state/claude-last-exit-code` | rašytas 2026-09-01 10:32 — vakarykštis pirminio medžio bėgimas |
| Sprendimas: `done` | `supervisor/decision.json` | 2026-09-01, task 015-b-03 |
| Stop būsena: `done stop hook allowed…` | `state/claude-stop-status.json` (source: legacy) | 2026-09-01, task 015-b-03 |
| Paskutinis aktyvumas: `2026-09-02T08:25:55Z` | `state/claude-resume.json` | šiandien, bet task 148-b-03 (w2) |
| Aktyvus vykdymas: 015-b-03 grandinė, „Srautas nežinomas" | `logs/claude-last.log` | 2026-09-01 10:32 — vakarykštė, jau baigta |
| W2 gyva užduotis: `148-b-03 (…m)` | wave snapshot `live_slots` | teisinga |

Šeši signalai iš septynių arba pasenę, arba priklauso kitam task'ui nei tas, apie kurį sako
etiketė. Tuo pat metu abu srautai realiai dirba ir tai matoma tik kompaktiškose kortelėse.

## Radiniai pagal prioritetą

### P1 — „Pagrindiniai signalai" skaito vieno slot'o pirminio medžio artefaktus

`src/interfaces/http/ui-dashboard-view.ts:316-323` ima `current-task-id`, `current-task-file`,
`claude-last-exit-code`, `supervisor/decision.json`, `claude-resume.json` ir stop įrodymą iš
`<runtimeRoot>/state`. Nuo worktree bangų (w1/w2 su `.ag/worktrees/...`) šiuos failus rašo TIK
pirminio medžio slot'as, kurio dabar nėra: vaikai rašo į SAVO kopijos `vq/`. Todėl
`adaptOverview` (`ui-app/src/model/dashboardViewModel.ts:84-144`) kiekvieną iš šešių metrikų
sudaro iš skirtingo laiko ir skirtingo task'o: „Claude rezultatas" ir „Sprendimas" — vakarykščiai
(015-b-03), „Paskutinis aktyvumas" — šiandienos w2 checkpoint'as (148-b-03), „Dabartinė
užduotis" — 012-a-02. Nė viena etiketė nesako, KURIO task'o tai signalas.

Kodėl nelogiška: SSE kelias tą pačią problemą jau išsprendė (task 139: `sse-adapters.ts:57-76`
ima log'ą iš worktree kopijos), o `/api/dashboard` liko vieno slot'o eroje. Du to paties ekrano
blokai atsako į „kas vyksta" iš skirtingų epochų.

Rekomendacija: kai `wave-snapshot.live_slots` netuščias, „Pagrindiniai signalai" turi būti
išvedami iš bandymo artefaktų per slot'ą (exit kodas, stop įrodymas, checkpoint'as iš
`<worktree>/vq/state` arba attempt namespace'o), o globalūs failai rodomi tik kai gyvų slot'ų
nėra — su etikete „paskutinis pirminio medžio bėgimas" ir data. Stop įrodymas turi `task_id`
lauką (`claude-stop-status.json`): kai jis nesutampa su rodomu task'u, signalas slepiamas arba
žymimas kaip svetimas, o ne rodomas su `title="source: legacy"`.

### P1 — Dvi „dabartinio task'o" žymės rašomos skirtingų kelių ir sulipdomos į vieną eilutę

`task-state-store.ts:325-336` `finishTaskState` BESĄLYGIŠKAI kviečia `setCurrentTaskFile(to)`.
Integracijos žingsnis (`wave-integration-adapters.ts:130-139` `relocateTask` →
`finishTaskInBucket`) kiekvieną kartą perkeldamas svetimo slot'o task'ą į `done` perrašo
`current-task-file` į to task'o `done/...` kelią, o `current-task-id` lieka toks, kokį paliko
paskutinis pirminio medžio dispatch'as. Audito momentu: `current-task-id = 012-a-02`,
`current-task-file = AG/tasks/done/149-…md`. `locateCurrentTaskBucket`
(`ui-dashboard-view.ts:249-262`) bucket'ą ieško pagal FAILO vardą, o ID ima iš KITO failo, tad
ekrane gimsta `012-a-02 (done)` su įspėjimu „Pasenusi užduoties būsena", nors 012-a-02 guli
`queue`, o `done` priklauso 149.

Rekomendacija: integracijos kelias žymės neliečia (`finishTaskState` gauna `updateCurrent`
parinktį kaip `moveTaskState`, arba terminalinis perėjimas žymes IŠVALO — task 126 tai jau daro
in-process keliui). Dashboard'as nelipdo ID iš vieno failo su bucket'u iš kito: jei bazių vardai
nesutampa, būsena yra „žymės prieštarauja", ne „stale".

### P1 — „Aktyvus vykdymas" rodo vakarykštį globalų log'ą, o antro srauto grandinė niekada nerenderinama

`agent-activity-reader.ts:45` globalus aktyvumas skaitomas iš `<runtimeRoot>/logs/claude-last.log`
(mtime 2026-09-01 10:32). `DashboardPage.tsx:197-202` į `AgentChainProgress` paduoda TIK šį
globalų `agentActivity`; `slots` prop'as (`AgentChainProgress.tsx:45`, blokas „Antras srautas",
sukurtas 2026-08-24 audite) iš puslapio NIEKADA neperduodamas, nors `useAgentActivity` per-slot'inį
`slots[]` jau skaito ir `SlotProgressCard` juo naudojasi. Rezultatas gyvos bangos metu: panelė
rodo užbaigtą 015-b-03 grandinę su „Srautas nežinomas" (koreliacija pagal `task_id` su gyvais
slot'ais neranda atitikmens — `slotProgressViewModel.ts:174-183`), o abiejų realiai dirbančių
srautų agentų grandinės nematomos niekur, išskyrus kompaktiškų kortelių procentų juostą.

Rekomendacija: `slots={agentSlotActivities}` į `AgentChainProgress`; kai `slots[]` netuščias,
per-slot'inės grandinės yra pagrindinis turinys, o globalus log'as neberodomas kaip „aktyvus"
(task 106 sprendžia tik antraštės „Paskutinis vykdymas" dalį — to nepakanka, kol turinys
imamas iš pasenusio failo).

### P2 — „Kas vyksta dabar" atsakymas gyvena ne valdymo centre ir remiasi ta pačia pasenusia žyme

`SystemStatusHero` (vienintelis blokas, atsakantis „kodėl ciklas stovi ir ko reikia iš manęs")
montuojamas tik `#/system` (`DashboardPage.tsx:261-272`), o `#/` aprašas žada „Critical attention,
active work, outcomes, and efficiency — in that order". Hero `currentTaskId` ima iš
`raw.currentTaskId` — tos pačios 012-a-02 žymės, tad su bėgančiu ciklu jis sako „Šiuo metu
vykdoma 012-a-02", kai vykdomi 148-a-02 ir 148-b-03.

Rekomendacija: hero perkelti (arba dubliuoti be mygtukų) į `#/` viršų; „vykdoma" tekstą
formuoti iš `loopControl.slots[].taskId`, ne iš žymės.

### P2 — Signalų asimetrija: W2 turi „gyva užduotis"/„paskutinė nesėkmė", W1 neturi nieko

`OverviewPanel.tsx:13-30` prideda `W2 live task` ir `W2 last failure` iš `slotProgress`, bet W1
analogų nėra — W1 gyva užduotis ekrane egzistuoja tik per pasenusią „Dabartinė užduotis" metriką.
Operatorius mato antrą srautą, o pirmojo — ne.

Rekomendacija: metrikas išvesti iš VISŲ `slotProgress` įrašų (arba nė iš vieno, paliekant
kortelėms); „Dabartinė užduotis" gyvos bangos metu turi būti sąrašas per slot'ą.

### P2 — Stop įrodymo ir aktyvumo „einamasis bandymas" seka tik pirmą gyvą slot'ą

`sse-adapters.ts:132` `readActiveAttempt` ima `live_slots[0]`: stebimų failų sąrašas ir
`stopStatusSource` visada aprašo w1. w2 bandymo stop būsena į srautą nepatenka, tad w2 baigtis
matoma tik kai snapshot'as pasikeičia, o ne kai jo stop įrodymas atsiranda.

### P3 — „Workflow snapshot" rodo neverstus bucket'ų raktus

`DashboardPage.tsx:385` spausdina `bucket.name` be `t()`: LT režime matoma `queue`,
`human-review`, `delegated`. Žodyne raktai `active`/`error`/`failed` egzistuoja kitiems
kontekstams, `queue`/`human-review`/`delegated` — ne. Ta pati eilutė rodo ir visada nulinius
`active`/`delegated`/`error`/`failed` be paaiškinimo, kas jie.

### P3 — „Bangos režimas: parallel 1/2" skamba kaip lygiagretus vykdymas, kai antras slot'as atmestas

`OverviewPanel.tsx:20-24`: kai prašyta 2, išduota 1, etiketė sako „parallel 1/2". Operatoriui tai
skaitosi „dirba lygiagrečiai", nors realiai suka vienas srautas; priežastis (`hard-cap`,
`missing-lease`) lieka kortelėje `#/system`.

## Kas veikia teisingai

- Srautų kortelės (`SlotStreamsOverview` → `SlotProgressCard compact`): task'as, būsena, fazė iš
  per-slot'inio bandymo log'o, praėjęs laikas iš lease'o. Skeleton'as rodomas tik kol nei
  valdiklio, nei bangų atsakymo nėra (`awaitingData` sąlyga teisinga).
- Visos apžvalgos etiketės turi LT vertimus (patikrinti 27 raktai).
- Ciklo mygtukų leidimas turi vieną šaltinį (`loopActionAllowed`), `unknown` uždaro paleidimą.
- `degraded` pranešimas įvardija neperskaitytą šaltinį, o ne tyliai slepia panelę.
- SSE hub'as: naujas klientas gauna šviežią kadrą, keepalive, praėjimai nepersidengia, klaida
  nenuverčia proceso.

## Ko netikrinau

- Vizualinio išdėstymo, spalvų, 390 px pločio, konsolės ir tinklo klaidų — naršyklės plėtinys
  neprisijungė. Ankstesnis vizualinis auditas: `ui-app-2026-08-31/report.md`.
- `#/tasks`, `#/reviews`, `#/analytics` ir kitų maršrutų — apimtis buvo tik `#/`.

## Siūloma task'ų eilė

1. Dashboard signalai iš gyvų slot'ų bandymo artefaktų; globalūs failai tik be gyvų slot'ų ir su
   data (P1-1 + stop įrodymo `task_id` sutapimo patikra).
2. `finishTaskState` nebeperrašo `current-task-file` integracijos kelyje; dashboard'as
   prieštaraujančias žymes rodo kaip prieštaravimą (P1-2).
3. `AgentChainProgress` gauna `slots`, per-slot'inės grandinės pirmiau už globalų log'ą (P1-3,
   suderinti su task 106).
4. Hero į `#/` ir „vykdoma" iš `loopControl.slots` (P2).
5. Simetriškos per-slot'inės metrikos, `readActiveAttempt` per visus gyvus slot'us, bucket'ų
   vertimai, bangos režimo formuluotė (P2/P3).
