# UI app paleidimo auditas — 2026-08-23

## Būsena: visi trys P0 uždaryti (2026-08-23, tą pačią dieną)

Radiniai ir jų sprendimai surašyti skyriuje [„Sprendimas"](#sprendimas-2026-08-23) šio
dokumento gale. Žemiau esantis verdiktas paliktas NEPAKEISTAS: auditas yra įrodymas apie
būseną, kuri buvo, ir jo perrašymas po pataisymo ištrintų tą įrodymą.

## Verdiktas (audito metu)

**P0 / blokuojama.** Operator UI neatvaizduoja net pirmo ekrano. `GET /api/dashboard` grąžina
`UiControlPlaneData`, o React klientas tą patį atsakymą interpretuoja kaip `DashboardData`.
Pirmasis adapteris bando skaityti neegzistuojantį `stopStatus.status`, React medis nulūžta, o
operatorius mato tuščią ekraną.

Tai yra paleidimo ir integracijos audito rezultatas, ne pilnas vizualinis UI/UX auditas. Pagal
realų produkto srautą nebuvo galima pasiekti jokio audituotino ekrano.

## Audito apimtis

- Produktas: vietinis VERQESTRA operatoriaus dashboard.
- Numatytas srautas: Apžvalga → Užduotys → Peržiūros → Sistema.
- Tikslas: įvertinti kasdienį operatoriaus darbą ir bazines prieinamumo rizikas.
- Darbalaukio peržiūra: 1440 × 1000.
- Paleidimas: `node dist/cli.js ui` su šviežiai perkompiliuotu `ui-app/dist`.

## Žingsniai

1. **Atidaryti dashboard — kritinė būsena.** Dokumentas ir statiniai failai įkeliami, bet React
   šakninis medis lieka tuščias.
2. **Apžvalga — nepasiekiama.** Klientas nulūžta prieš pirmą renderį.
3. **Užduotys — nepasiekiama.** Navigacija nesukuriama.
4. **Peržiūros — nepasiekiama.** Navigacija nesukuriama.
5. **Sistema — nepasiekiama.** Navigacija nesukuriama.
6. **Siauras ekranas ir prieinamumas — nepatikrinta.** Nėra stabilaus UI, kurį būtų galima
   patikrinti vizualiai ar klaviatūra.

## P0 radinys: nesutampa `/api/dashboard` kontraktas

Serverio kelias:

- `src/interfaces/http/ui-router.ts:160` perduoda `/api/dashboard` į `dashboardData`.
- `src/composition/ui/router-adapters.ts:98` `dashboardData` grąžina
  `loadUiControlPlaneData(...)` rezultatą.
- `src/interfaces/ui-model/control-plane-model.ts:126` apibrėžia šį rezultatą kaip
  `UiControlPlaneData` su `config_controls`, `loop_controls`, `human_review_tasks` ir kitais
  snake_case laukais.

Kliento kelias:

- `ui-app/src/model/api.ts` atsakymą be runtime validacijos pažymi kaip `DashboardData`.
- `ui-app/src/model/types.ts:194` `DashboardData` reikalauja `root`, `stopStatus`, `decision`,
  `runtime`, `workflowBuckets` ir kitų laukų.
- `ui-app/src/controller/useDashboardController.ts:187` pradeda kurti vaizdo modelį iš šio
  neteisingai tipizuoto atsakymo.
- `ui-app/src/model/dashboardViewModel.ts:85` skaito `data.stopStatus.status` ir meta
  `TypeError: Cannot read properties of undefined (reading 'status')`.

## Kas veikia

- Statinis HTML, CSS ir JavaScript paketas pateikiamas sėkmingai.
- Produkcinė UI kompiliacija praeina.
- Visi 46 UI testų failai praeina: 393/393 testai.

## Testų spraga

Žali testai šio gedimo nepagauna, nes abu kontrakto galai tikrinami atskirai:

- UI kontrolerio testai sukuria `DashboardData` objektus patys.
- HTTP maršruto ir control-plane modelio testai tikrina `UiControlPlaneData` atskirai.
- Nėra smoke/integracinio testo, kuris paleistų realų serverį, atidarytų `/` ir patvirtintų, kad
  matomas pagrindinis dashboard turinys.

## Prieinamumo poveikis

Tai absoliutus barjeras visiems vartotojams: nėra semantinės struktūros, navigacijos, fokusavimo,
statuso ar klaidos pranešimo. Iš tuščio ekrano negalima spręsti apie WCAG atitiktį; kontrasto,
klaviatūros, fokusavimo, target dydžio, reflow ir screen reader patikros turi būti kartojamos tik
atkūrus pirmą stabilų ekraną.

## Rekomendacijos

1. **P0:** suvienodinti `/api/dashboard` wire kontraktą. Serveris turi grąžinti tikrą
   `DashboardData` su `controlPlane` viduje arba klientas turi aiškiai adaptuoti
   `UiControlPlaneData`; dabartinis TypeScript cast nėra kontraktas.
2. **P0:** pridėti runtime schemos validaciją klientui ir naudotojui matomą klaidos ribą, kad
   neteisingas atsakymas nevirstų tuščiu ekranu.
3. **P0:** pridėti end-to-end smoke testą: paleisti realų UI serverį, atidaryti `/`, laukti
   `System overview` arba lietuviško atitikmens ir drausti neapdorotas konsolės klaidas.
4. **Po pataisymo:** pakartoti pilną kombinuotą UX ir prieinamumo auditą visu numatytu srautu.

## Patikros

- `pnpm build:ui` — praeina.
- `pnpm test:ui` — praeina, 46/46 failai ir 393/393 testai.
- Realus atidarymas — nepraeina; tuščias ekranas ir neapdorota JavaScript klaida.
- Tuščias kadras atmestas ir neišsaugotas kaip audito ekrano įrodymas, nes neatitiko priėmimo
  kriterijų.

## Sprendimas (2026-08-23)

### Šaknis, ne simptomas

`loadDashboardData` (etalono `interfaces/cli/ui/index.ts`, 527 eil.) VQ-503/VQ-504 metu nebuvo
perkeltas. Perkelta buvo tik viena jo dalis — `loadUiControlPlaneData` — ir kompozicija ją
prisegė TIESIAI prie `/api/dashboard`. Tai ne cast'o klaida: tai neužbaigta migracija, kurios
niekas nepamatė, nes dashboard'o iki VQ-601 dar nebuvo. Todėl taisymas yra trūkstamo modulio
perkėlimas, o ne adapteris kliente.

### P0-1 — wire kontraktas suvienodintas

Naujas `src/interfaces/http/ui-dashboard-view.ts` (`buildDashboardView`): visas snapshot'as su
`controlPlane` VIDUJE, laukų vardai 1:1 su `ui-app/src/model/types.ts#DashboardData`. Slot'ų
derivacija iškelta į gryną `src/interfaces/ui-model/loop-slot-model.ts` (`deriveLoopSlots`,
etalonas 1:1). Portai surišti naujame `src/composition/ui/dashboard-adapters.ts`; jame
`workflowBuckets` paduodami IŠ IŠORĖS — tie patys portai, kuriuos naudoja `/api/tasks`, kad
apie tą pačią eilę neatsirastų du atsakymai.

Perimtos ir etalono savybės, kurių `UiControlPlaneData` neturėjo: attempt-first stop įrodymas
su matoma kilme (`stopStatusSource`), `currentTaskBucket`/`currentTaskState`, runtime procesų
sąrašas su `selfRegistering` skirtumu (be jo „Paleisti ciklą" liktų negyvas po kiekvieno švaraus
sustojimo), worker/loop valdikliai, `queueCounts`, `statusFiles` ir `token_budget`.

Vienas SĄMONINGAS nukrypimas nuo etalono, griežtinantis: kiekvienas šaltinis gniūžta atskirai ir
patenka į `degraded[]`. Etalone vienas sugadintas artefaktas paversdavo visą `/api/dashboard`
500-uku — t. y. dashboard'as mirdavo būtent tada, kai jo labiausiai reikia. `controlPlane`
degradavęs PRALEIDŽIAMAS, o ne siunčiamas tuščias: klientui `undefined` reiškia „duomenų nėra",
o tuščias sąrašas melagingai reikštų „nieko nelaukia".

### P0-2 — runtime validacija ir matoma klaida

`ui-app/src/model/dashboardContract.ts` (`parseDashboardData`) tikrina laukus, kuriuos vaizdo
modelis dereferencina BE saugiklio, ir meta `DashboardContractError` su ĮVARDYTAIS trūkstamais
laukais bei veiksmu („perkrauk UI serverį"). `fetchDashboard` nebenaudoja `as DashboardData`.
Klaida pasiekia jau egzistavusią `DashboardPage` klaidos juostą (`role="alert"`).

Papildomai — `ui-app/src/view/components/ErrorBoundary.tsx`, apvyniotas VIRŠ `I18nProvider`
`AppRoot`e: bet kokia renderio klaida nuo šiol duoda matomą pranešimą, o ne baltą puslapį.
Riba sąmoningai neverčia teksto per `t()` — ji privalo veikti ir tada, kai lūžo pats i18n
kontekstas.

### P0-3 — vartai, kurių nebuvo

Trys nauji testų failai uždaro būtent tą spragą, kurią auditas įvardijo („abu galai tikrinami
atskirai"):

| Failas | Ką pin'ina |
|---|---|
| `src/tests/composition-ui-dashboard-contract.test.ts` | TIKRAS `node:http` serveris + TIKRI adapteriai; `GET /api/dashboard` privalo turėti kiekvieną kliento reikalaujamą lauką, `controlPlane` — būti VIDUJE, `degraded` — tuščias |
| `src/tests/interfaces-http-dashboard-view.test.ts` | vaizdo taisyklės: tuščia būsena, einamojo task'o bucket'as, degradavęs šaltinis, `live_slots` autoritetas, `drain`/`abort` |
| `ui-app/src/dashboardSmoke.test.tsx` | pirmas ekranas: TEISINGA forma duoda „Sistemos apžvalgą"; SENOJI (control-plane) forma duoda matomą klaidą, ne tuščią ekraną |
| `ui-app/src/model/dashboardContract.test.ts` | kontrakto pažeidimų sąrašas ir `null` vs `undefined` skirtumas |

Privalomų laukų sąrašas dubliuojamas serverio ir kliento pusėse SĄMONINGAI (paketai turi
atskirus toolchain'us, o kliento importas iš `src/` sulaužytų `ui-app` build'ą). Abi vietos
nurodo viena į kitą komentaruose.

### Ko šis darbas NEAPIMA

- **Naršyklės e2e.** Šio repo toolchain'e headless naršyklės nėra, o `node dist/cli.js ui`
  paleidimo neleidžia bash politika (`generatedHookRuntimeRegex` saugo hook'ų runtime).
  Serverio pusę dengia realus HTTP testas, renderio pusę — jsdom smoke testas; realaus
  atidarymo įrodymą turi pridėti operatorius.
- **Rekomendacija 4** — pilnas UX ir prieinamumo auditas visu srautu (Apžvalga → Užduotys →
  Peržiūros → Sistema). Jis buvo užblokuotas P0 ir dabar yra atrakintas, bet neatliktas.

### Patikros po pirmo rato

- `pnpm typecheck` — praeina.
- `pnpm lint` — praeina.
- `pnpm test` — praeina, 1484/1484 (buvo 1473; +11).
- `pnpm typecheck:ui` — praeina.
- `pnpm test:ui` — praeina, 48/48 failai ir 402/402 testai (buvo 46/393; +2 failai, +9 testai).
- `pnpm build:ui` — praeina, 94 moduliai.

## Antras ratas: endpoint'ų auditas (2026-08-23)

Pirmas ratas atidarė pirmą ekraną. Antras ratas — operatoriaus prašymu — patikrino KIEKVIENĄ
kliento kvietimą prieš maršrutą, kurį jis pasiekia: kelią, kūną, atsakymo formą ir statusą.
Metodas buvo mechaniškas: `ui-app/src/model/api.ts` (21 kvietimas) + du tiesioginiai `fetch`
(`/api/events`, `/api/waves`) sugretinti su `interfaces/http/ui-router.ts` maršrutais ir
`composition/ui/router-adapters.ts` grąžinamomis formomis.

Rasta **13 defektų, iš jų 6 kritiniai**. Visi uždaryti. Bendra jų priežastis viena ir ta pati
kaip pirmame rate: VQ-503/VQ-504 metu prijungti buvo ne use-case'ai, o artimiausi žemesnio
lygio moduliai — `appendPolicyProposal` vietoj `policy-proposal-service`, `summarizeTokenUsage`
vietoj užklausos vaizdo, `buildReliabilityAnalytics` vietoj kešuojančio `loadReliabilityAnalytics`.
Kiekvienas paviršius atskirai buvo ištestuotas ir žalias; nė vienas testas neklausė, ar
klientas gaus tai, ko prašo.

### Kritiniai

| # | Maršrutas | Kas buvo | Pasekmė operatoriui |
|---|---|---|---|
| E1 | `POST /tasks/resume` | žalias rezultatas be `{ loop }` | mygtukas rodė `▶ undefined`; nepavykęs paleidimas atrodė kaip sėkmė |
| E2 | `POST /tasks/stop` | be `{ loop, loop_control }`; `drainAllSlots` nekviestas | „stop" visada rodė „nėra žinomo proceso"; po Stop srautai ekrane liko `run` |
| E3 | `POST /api/runtime/loop/start` | kūnas `{ workers }` **ignoruojamas**, `resetLoopControl` nekviestas, vokas žalias | „paleisti 2 srautus" dingdavo tyliai; senas `drain` priversdavo ką tik paleistą ciklą atsisakyti pirmo task'o; ekrane — „Ciklas paleistas su 2 srautais" |
| E4 | `POST /api/policies/{grupė}/set` | **maršruto nebuvo** | kiekvienas politikų valdiklis grąžino 404 |
| E5 | `POST /api/policies/proposals/{approve\|reject\|apply}` | prirašydavo PASIŪLYMĄ su svetimu `verb`; `strictObject` jį atmesdavo | visi trys mygtukai grąžino 500; `apply` niekada nerašė politikos failo; `ProposalNotApproved` ir `HumanReviewApprovalRequired` vartų kelyje NEBUVO |
| E6 | `GET /api/policies/proposals` | žalias `PolicyProposal[]` be `{ proposals }` | panelė amžinai „Įkeliama…", be klaidos |

Prie E5 verta pridėti tai, ko lentelė nerodo: `POST /api/policies/propose` priimdavo pasiūlymą,
kurio `routing` atkeliauja **iš kliento**. Suklastotas `routing: "queue"` panaikintų human-review
reikalavimą prie `apply` — vartus, kurie egzistuoja būtent tam, kad sistema negalėtų sau
išsirašyti leidimo. Maršrutas pakeistas etalono forma, kurioje `old_value`, `timestamp` ir
`routing` nustato SERVERIS, o `actor` niekada neateina iš kūno.

### Likę

| # | Vieta | Kas buvo | Sprendimas |
|---|---|---|---|
| E7 | `GET /api/token-usage` | grąžindavo SUVESTINĘ vietoj `{ records, pagination }`; visi filtrai (`model`, `phase`, `from`, `to`, `limit`, `offset`) ignoruojami | naujas `application/analytics/token-usage-query` (etalonas 1:1) |
| E8 | `GET /api/token-analytics` | grąžindavo ŽALIĄ snapshot'ą vietoj `{ groups, candidates, history }` | prijungtas jau egzistavęs `buildTokenAnalyticsResponse` |
| E9 | `POST /api/runtime/workers` | be `{ worker_request }`; `InvalidWorkerRequestError` → 500 | vokas + 400 |
| E10 | `POST /api/runtime/loop/slots/<id>` | `InvalidLoopControlError` → 500 | 400 |
| E11 | `GET /api/reliability-analytics` | `?fresh=1` ignoruojamas, 10 s kešas nepanaudotas | prijungtas `loadReliabilityAnalytics(…, fresh)`; git zondai nebesukami kas pollingą |
| E12 | `ui-waves-view` | `hard_capped: boolean`, nors schema ir klientas sako `number` | tipas ištaisytas; „nukirsta 2" nebėra `true` |
| E13 | `ui-error-mapping#mapPolicyError` | nulis kvietėjų (E4/E5 pasekmė) | prijungtas per `mapPolicyDecisionError` |

### Nukrypimas nuo etalono (griežtinantis)

Netinkama siūloma politikos reikšmė (`requested_value: "error"` ten, kur leidžiami tik
`advisory|warn|block`) etalone krisdavo į bendrą 500. Dabar tai 400 su paaiškinimu: tai
VARTOTOJO klaida — lygiai ta pati klasė, kurią įvardija paties `ui-error-mapping` pirmoji
taisyklė. 500 nukreiptų operatorių ieškoti serverio gedimo vietoje netinkamos reikšmės.

### Struktūriniai pakeitimai

`ui-router.ts` išskaidytas, nes skaitymo ir rašymo pusės elgiasi PRIEŠINGAI klaidos atveju
(skaitymas degraduoja, rašymas krenta garsiai), o po pataisymų nebetilpo į 500 eilučių vartą:

- `interfaces/http/ui-router-model.ts` — portai, atsakymų formos, bendri konstruktoriai;
- `interfaces/http/ui-router-mutations.ts` — visos `POST` mutacijos;
- `interfaces/http/ui-router.ts` — vartų tvarka + `GET`;
- `composition/ui/{analytics,policy}-adapters.ts` — telemetrijos ir governance surišimas.

### Vartai, kurių nebuvo (antras ratas)

| Failas | Ką pin'ina |
|---|---|
| `src/tests/interfaces-http-router-contracts.test.ts` | KIEKVIENO voko forma (`{loop}`, `{loop, loop_control}`, `{worker_request}`, `{proposals}`), `workers → requested` vertimas, žingsnių TVARKA (`workers → reset → start`), statusai 400/403/409 ir tai, kad `routing`/`actor` iš kliento nepriimami |
| `src/tests/composition-ui-policy-governance.test.ts` | pilnas srautas REALIAIS failais: pasiūlymas → 409 be patvirtinimo → approve → apply RAŠO politikos failą; human-review kelias duoda 403 ir praeina tik su žmogaus žyme; `actor: "ui-local"` |
| `src/tests/application-token-usage-query.test.ts` | filtrai, datos ribos įskaitymas, puslapiavimas nuo žurnalo galo, `?limit=0` |
| `ui-app/src/model/apiEnvelopes.test.ts` | kliento pusė: vokas be `loop`/`proposals` duoda MATOMĄ klaidą, ne tylią sėkmę |

### Patikros po antro rato (žr. taip pat trečią ratą žemiau)

- `pnpm typecheck` — praeina.
- `pnpm lint` — praeina.
- `pnpm test:compiled` — 1504/1515. **11 kritimų priklauso lygiagrečiai sesijai** (code-index /
  code-graph / context-cache), ne šiam darbui; visi UI ir architektūros vartų testai žali
  (`architecture-gates` 5/5).
- `pnpm typecheck:ui` — praeina.
- `pnpm test:ui` — praeina, 49/49 failai ir 408/408 testai.
- `pnpm build:ui` — praeina.

## Trečias ratas: srautas, degradavimas ir wiring (2026-08-24)

Pirmas ratas atidarė pirmą ekraną, antras — sutvarkė užklausų/atsakymų kontraktus. Trečias
apžiūrėjo tai, ko nelietė nė vienas: **SSE srautą**, **degradavimo kanalą** ir **prijungimą**
(ar kiekvienas UI paviršiaus įėjimas turi produkcinį kvietėją).

### P0 — SSE praėjimo klaida NUTRAUKDAVO UI SERVERIO PROCESĄ

`createSseHub.checkAndBroadcast` neturėjo `catch`, o taimeris jį paleisdavo per
`void checkAndBroadcast()`. Vadinasi, bet kuris šaltinio skaitymo gedimas tapdavo **neperimtu
atmetimu**, o Node 15+ tokį verčia neperimta išimtimi ir **nutraukia procesą**. Tas pats procesas
aptarnauja dashboard'ą ir valdo loop'ą.

Kelias nėra teorinis. Praėjimas kas 1,5 s skaito `claude-last.log` ir bandymo artefaktus, kuriuos
**lygiagrečiai rašo vykdytojas**; Windows EBUSY ties tuo failu šiame repo jau dokumentuotas
(`claude-last-log` dviejų kanalų rašytojas su backoff). Tai reiškia, kad dashboard'as krisdavo
**aktyvaus dispatch'o metu** — tiksliai tada, kai jo labiausiai reikia. Etalonas turi tą pačią
spragą (`ui/sse-service.ts:259`), tad tai **etalono spraga**, o taisymas — griežtinantis
nukrypimas.

Sprendimas: `SsePorts` gavo **privalomą** `logError`; praėjimas ir pirmasis snapshot'as apgaubti
`catch`. Nepavykęs praėjimas praleidžiamas ir pavadinamas — kitas praėjimas po 1,5 s yra
natūralus pakartojimas. Kartu ištaisyta smulkesnė to paties kodo klaida: `lastMtimes` žymės buvo
atnaujinamos **prieš** `activityPayload`, tad jam nukritus pokytis dingtų NEGRĮŽTAMAI; dabar
žymės rašomos tik sudėjus krovinį. `addClient` nesėkmė nebeišmetama: antraštės jau išsiųstos, tad
išimtis reikštų srautą, kuris niekada neatiduoda nė vieno kadro.

### P1 — degradavimo kanalas be vartotojo

Pirmas ratas įvedė `/api/dashboard#degraded[]` su komentaru, kad sugadintas artefaktas virsta
„įvardytu degradavusiu bloku, o ne 500". Bet lauko **nebuvo kliento tipe**, tad vardas niekada
nepasiekdavo ekrano. Praktinė pasekmė: sugriuvus `control_plane`, `#/reviews` tyliai netekdavo
politikų valdiklių, o **`#/learning` rodydavo TIK antraštę ir tuščią lapą** — tas pats tylus
gedimas, kurį visas šis auditas ir uždarinėja, tik vieno ekrano dydžio.

Sprendimas: `degraded` įtrauktas į `DashboardData`, kontroleris jį perduoda, `DashboardPage` rodo
įvardytą pranešimą (ta pati forma kaip `WavesPanel`), o `#/learning` be control-plane bloko gauna
aiškią būseną su „bandyti dar kartą", ne tuščią lapą.

### UI autostart buvo neprijungtas — PRIJUNGTA (operatoriaus sprendimu)

`interfaces/http/ui-lifecycle.ts` (170 eil.: `ensureUiRunning`, `uiPidFile`, `UI_AUTOSTART_ENV`,
starto malonės langas) yra pilnai perkeltas ir ištestuotas, bet **produkcinių kvietėjų turi nulį** —
tik testus. Etalone jį kviečia `interfaces/cli/claude-loop/index.ts:516`, iš karto po prielaidų
vartų: `verqestra loop` ten pakelia dashboard'ą pats. VERQESTRA'oje to kvietimo nėra, tad
operatorius, paleidęs ciklą, dashboard'o negauna, kol nepaleidžia `verqestra ui` ranka.

Tai **septintas** šio repo „mechanizmas be wiring'o" atvejis. Iš pradžių jį palikau operatoriui,
nes prijungimas priverčia `verqestra loop` spawn'inti atsietą serverio procesą, užimti prievadą ir
perrašyti `vq/state/ui-server.json` — išorinis šalutinis efektas komandai, kurios auditas neapima.
Operatorius nusprendė jungti.

Prijungta `composition/cli/commands-ops.ts` `loop` komandoje, iš karto po `ensureRuntimeDirs` ir
**prieš** `runLoopCommand`: po ciklo kvietimas įvyktų tik eilei ištuštėjus, t. y. tada, kai
dashboard'o nebereikia. Trys sprendimai, kurie yra šio surišimo kontraktas:

1. **Rezultatas neima sprendimo.** UI yra stebėjimo paviršius, ne ciklo prielaida. Nesėkmė pati
   praneša per `uiStartFailed` → `io.error`, tad ji matoma, bet eilės nestabdo — priešingu atveju
   užimtas prievadas blokuotų darbą, kurio jis tik nerodo.
2. **Kiekvienas mūsų spawn'intas vaikas gauna `AG_UI_AUTOSTART=0`** (etalonas: `ui/{loop,ui}-service.ts`).
   Be to grandinė būtų begalinė: UI paleidžia loop'ą, loop'as pakelia UI, tas vėl paleidžia loop'ą.
   Vėliava paveldima, tad ji uždaro VISĄ grandinę, ne vieną pakopą.
3. **Prievado portai (`uiPortPorts`) eksportuoti, o ne nukopijuoti**: juos dabar naudoja du keliai
   (`ui` komanda ir autostart'as), o antra kopija duotų du skirtingus atsakymus apie tą patį
   prievadą — būtent porto tapatybė skiria „mūsų serveris" nuo „svetimas procesas".

Išjungiama `AG_UI_AUTOSTART=0`; užrašyta README `loop` eilutėje.

Smulkiau: `useDashboardController.logBytes` buvo skaičiuojamas be nė vieno vartotojo — ištrintas.
`adaptOverview` gamina 6 metrikas, o `#/` rodo `.slice(0, 4)` (paskutinės dvi — „Latest activity",
„Stable commit" — niekur nepatenka). Tai **etalono elgesys 1:1** (`DashboardPage.tsx:181` ten pat),
tad palikta kaip produkto sprendimas, ne kaip klaida.

### Vartai (trečias ratas)

| Failas | Ką pin'ina |
|---|---|
| `src/tests/interfaces-http-sse.test.ts` (+2) | šaltinio klaida NEIŠEINA iš hub'o nei tiesioginiame, nei TAIMERIO kelyje; ji pavadinama; klientas lieka prijungtas; pokytis NEPRARANDAMAS ir atkeliauja kitame praėjime; pirmo snapshot'o klaida palieka ryšį atvirą |
| `ui-app/src/dashboardSmoke.test.tsx` (+2) | degradavęs šaltinis PAVADINAMAS ekrane; `#/learning` be control-plane bloko rodo įvardytą būseną, ne tuščią lapą |
| `src/tests/composition-ui-autostart.test.ts` (naujas) | `ensureUiRunning` turi produkcinį kvietėją IR jis stovi prieš ciklą; abu spawn'ai neša `AG_UI_AUTOSTART`; vėliavos vardas imamas iš modulio, ne rašomas ranka |

Paskutinis vartas skaito ŠALTINĮ, o ne elgesį — sąmoningai, ir tai ne trumpinys. Visi septyni šio
repo „mechanizmas be wiring'o" atvejai praėjo pro žalius vienetinius testus, nes vienetinis testas
tikrina mechanizmą, o ne tai, ar kas nors jį kviečia. Tas pats šablonas jau naudojamas
`scheduling-safe-telemetry`.

### Patikros po trečio rato

- `pnpm typecheck`, `pnpm lint`, `pnpm typecheck:ui` — praeina.
- `pnpm test` — praeina, **1542/1542** (lygiagrečios sesijos kritimai irgi uždaryti).
- `pnpm test:ui` — praeina, 49/49 failai ir **410/410** testai.
- `pnpm build:ui` — praeina.
- Realus atidarymas naršyklėje — **vis dar nepatikrintas** (toolchain'e nėra headless naršyklės, o
  `ui` komandos paleidimo neleidžia bash politika). Įrodymą turi pridėti operatorius.

## Ketvirtas ratas: prieinamumas (2026-08-24) — originalaus audito rekomendacija 4

Rekomendacija 4 („pakartoti pilną UX ir prieinamumo auditą") buvo užblokuota P0 nuo pirmos dienos.
Atrakinta ji buvo pirmame rate; čia padaryta ta jos dalis, kurią galima **išmatuoti be naršyklės** —
struktūra, fokusas ir dokumento tapatybė. Kontrasto, target dydžio, reflow ir screen reader
patikros lieka operatoriui: joms reikia realaus renderio, ir jų „patikrinau" be jo būtų melas.

Pirmiausia patikrinta, kas JAU teisinga, kad taisymas nevirstų perrašymu: `nav` turi
`aria-label`, aktyvus skirtukas — `aria-current="page"`, piktogramos `aria-hidden`, kalbos
perjungiklis — `role="group"` + `aria-pressed`, pranešimai — `role="status"`/`role="alert"`,
lentelės — `visually-hidden` `<caption>`, o `I18nContext` atnaujina `document.documentElement.lang`
(be to screen reader'is skaitytų lietuvišką tekstą angliškomis fonemomis). Rasti **du** realūs
trūkumai.

### WCAG 2.4.1 „Bypass Blocks" — navigacijos praleidimo nebuvo

Kiekviename maršrute prieš turinį stovi 9 navigacijos skirtukai ir 6 įrankių juostos mygtukai.
Klaviatūra dirbančiam operatoriui tai 15 `Tab` paspaudimų iki KIEKVIENO ekrano, ir taip po
kiekvieno perkrovimo.

Sprendimas — `SkipToContent`, pirmas fokusuojamas elementas, nematomas iki fokuso. **Mygtukas, o
ne `<a href="#main-content">`**, ir tai ne stiliaus pasirinkimas: dashboard'as maršrutizuojasi per
`window.location.hash`, tad įprastas skip-link šablonas perrašytų hash'ą, `readRoute` jo
neatpažintų, ir operatorius vietoj turinio atsidurtų „Apžvalgoje" — prieinamumo pagerinimas, kuris
tyliai sulaužo navigaciją. Taikinys randamas runtime (`document.querySelector("main")`), nes vienu
metu renderinamas lygiai vienas `<main>`, o `tabindex` nustatomas prieš pat fokusavimą: be jo
`focus()` ant ne-interaktyvaus elemento nieko nedaro.

### WCAG 2.4.2 „Page Titled" — antraštė nesikeitė niekada

`document.title` buvo statinis visiems devyniems maršrutams. Pasekmė ne tik formali: naršyklės
istorijoje kiekvienas įrašas atrodo vienodai, o operatorius su keliais atidarytais projektų
dashboard'ais neturi jokio būdo pasakyti, kuri kortelė ką rodo — tas pats klausimas, kurį
serverio pusėje sprendžia `uiServer.projectFingerprint`.

Antraštė dabar seka maršrutą, o rašytojas VIENAS (`RoutedApp`) — du efektai kovotų dėl to paties
lauko. Kartu pašalintas dubliavimas: maršrutų pavadinimai persikėlė į `ROUTE_LABELS` šalia
`Route` tipo, ir tą patį sąrašą naudoja navigacijos skirtukai bei antraštė. Dvi kopijos leistų
kortelei ir skirtukui pasakyti skirtingus dalykus apie tą patį ekraną.

### Vartai (ketvirtas ratas)

| Failas | Ką pin'ina |
|---|---|
| `ui-app/src/view/accessibility.test.tsx` (naujas) | praleidimo mygtukas yra PIRMAS fokusuojamas elementas DOM tvarkoje; jis perkelia fokusą į `main`; jis NEKEIČIA maršruto; dokumento antraštė seka maršrutą |
| `ui-app/src/view/components/ErrorBoundary.test.tsx` (naujas) | riba paverčia renderio klaidą matomu pranešimu su klaidos tekstu IR veiksmu; sveikas medis praeina nepaliestas; pakartojimo mygtukas realiai atstato medį; klaida nepraryjama |

### Spraga MANO PAČIO pirmo rato darbe

`ErrorBoundary` buvo pridėtas pirmame rate kaip paskutinė riba tarp renderio klaidos ir tuščio
ekrano — tiksliai to gedimo, dėl kurio auditas prasidėjo — ir liko **be nė vieno testo**.
Neištestuotas saugumo tinklas yra prielaida, ne riba: React klaidų riba nutyla, jei
`getDerivedStateFromError` nustoja būti `static`, o vienintelis požymis būtų baltas puslapis.

Rašant testą išlindo dalykas, vertas užrašyti: **React 19, nukritus konkurenciniam renderiui,
atsigauna perrenderindamas šaknį SINCHRONIŠKAI**. Pirmoji testo versija naudojo komponentą, kuris
metė tik pirmą kartą — antrame, sinchroniniame praėjime jis nebemetė, riba į klaidos būseną
nepateko, ir testas krito. Tai reiškia, kad klaidų ribos testas su „metančiu vieną kartą" vaiku
duoda **klaidingą rezultatą abiem kryptimis**. Todėl vaikas meta pagal IŠORINĮ jungiklį, o šaknis
montuojama ranka per `createRoot` su `onRecoverableError`: ta React diagnostika apie savo paties
atsigavimą jsdom'e keliauja į `window.onerror` ir nuverčia testą, o RTL `render` šio parametro
neatiduoda.

### Patikros po ketvirto rato

- `pnpm typecheck`, `pnpm typecheck:ui` — praeina.
- `pnpm test:ui` — **51/51 failai, 417/417 testai**; `pnpm build:ui` — praeina.
- Serverio pusė ketvirtame rate NELIESTA (pakeitimai tik `ui-app/`).
- `pnpm test` — 1559/1561. **Abu kritimai priklauso lygiagrečiai sesijai** (`context-pack`
  assemble ir `CONTEXT_CACHE_VERSION` priminimo testas — jos darbas tuo metu buvo pusiaukelėje).
  Visi UI ir architektūros vartų testai žali.

## Penktas ratas: kelio nutekėjimas ir GILIŲ DTO sulyginimas (2026-08-24)

Antras ratas sulygino atsakymų **VOKUS** (`{loop}`, `{proposals}`, `{records, pagination}`), bet
ne jų VIDŲ. Penktas ratas paėmė tris likusius gilius DTO ir vieną radinį, kurį ketvirtame rate
įvardijau, bet atidėjau.

### Absoliutus kelias, keliaujantis į naršyklę — IŠTAISYTA

`HumanReviewApprovalRequiredError` žinutė nešė ABSOLIUTŲ žymės kelią, o `ui-error-mapping` ją
perduoda kaip 403 kūną. Į naršyklę taip iškeliaudavo disko raidė, vartotojo vardas ir įdiegimo
vieta — tiksliai tai, ką `free-text-redaction` sąmoningai kerpa iš bangų vaizdo, o paties
`ui-error-mapping` antraštė vadina „vidinėmis detalėmis, liekančiomis serverio pusėje". Ta pati
taisyklė jau taikoma benchmark DTO (`BenchmarkReportSource.path`: „Repo-relative. A DTO served over
HTTP never discloses a location on the host") — politikų klaida buvo vienintelė išimtis.

**Aklas redagavimas į `<path>` čia būtų buvęs neteisingas taisymas**: šios žinutės VISA prasmė yra
pasakyti, KUR sukurti failą, tad `sanitizeFreeText` ją paverstų beverte. Sprendimas — repo-reliatyvus
kelias: veiksmas išsaugotas (operatorius savo šaknį mato Header'yje), o šaknis neišeina. Būtent
todėl `free-text-redaction` santykinius kelius palieka matomus. Patikra ir toliau eina ABSOLIUČIU
keliu (`humanReviewApprovalMarkerPath`), o pranešama nauju `humanReviewApprovalMarkerRef`.

### Gilūs DTO: trys sulyginti, vienas įvardytas kaip svetimas

| Riba | Verdiktas |
|---|---|
| `/api/token-analytics` | **sutampa** laukas į lauką (`TaskFamilyGroup`, `OptimizationCandidate`, `TokenAnalyticsSnapshot`) |
| `/api/waves` → `UiWaveSlot` | **sutampa** laukas į lauką (po antrame rate ištaisyto `hard_capped`) |
| `/api/benchmark/report` vokas | **sutampa**; `source.path` jau repo-reliatyvus pagal savo paties kontraktą |
| `/api/benchmark/report` DOKUMENTO vidus | **NE šio audito riba.** Serveris jį laiko neskaidriu įrodymu ir persiunčia pažodžiui (`modes: z.array(z.unknown())`, `looseObject` visur, komentaras: „orkestratorius čia kurjeris, ne autorius"). Tikroji riba yra `AG/benchmark` raporto modelis ↔ `ui-app` tipai, ir ji priklauso BENCH apimčiai. Įvardyta, o ne pusiau patikrinta |

### Patikros po penkto rato

- `pnpm typecheck`, `pnpm lint` — praeina.
- `pnpm test` — **1565/1565**; `pnpm test:ui` — 51/51 failai, **417/417**.

## Šeštas ratas: `AG/benchmark` ↔ `ui-app` riba (2026-08-24)

Penktame rate šią ribą ĮVARDIJAU kaip nepatikrintą ir priklausančią BENCH apimčiai. Šeštas ratas
ją patikrino — nes „įvardyta" nėra „uždaryta", o `#/benchmark` yra ištisas ekranas, kurio wire
kontraktas niekada nebuvo sulygintas.

### Rezultatas: struktūriškai ŠVARU

Sulyginta laukas į lauką: `ReportIdentity`, `ReportRunFacts`, `ReportMetricRow`,
`ReportModeSection`, `ReportScenarioSection`, `DistributionStatistics`, `ReportReproduction` —
visi sutampa su `ui-app` atitikmenimis. Sutampa ir visos trys sąjungos: `EXECUTION_MODES`,
`COMPARISON_VERDICTS`, `MODE_DIFFERENCE_ASPECTS`.

Viena asimetrija, palikta SĄMONINGAI: paketas raportuoja `compression: ReportCompressionSection`,
o klientas šio lauko nei tipuoja, nei rodo. Tai ne klaida, o nepadaryta funkcija (kompresijos
kohortos panelė) — tos pačios klasės kaip trečiame rate rastas `logBytes`. Įvardyta, kad nedingtų.

### Ko trūko: sąjungos buvo persakytos TRIS kartus be varto

Švara be varto yra šios dienos būsena, ne savybė. Kiekviena iš trijų sąjungų gyvena trijose
vietose — paketo domene (šaltinis), orkestratoriaus DTO sluoksnyje ir `ui-app` tipuose — ir jas
laikė TIK komentaras „Mirrors `COMPARISON_VERDICTS` of the benchmark package". Paketui pridėjus
ketvirtą režimą, klientas jį rodytų kaip nežinomą, o abu galai liktų žali — lygiai kaip pirmame
šio audito rate.

Vartas ne naujas: praplėstas jau egzistavęs `src/tests/benchmark-restated-contracts.test.ts`,
kurio antraštė šią klasę jau įvardija („Persakymas be saugiklio yra tos pačios klasės ketvirtas").
Šis — penktas ir didžiausias. Šaltinis skaitomas kaip TEKSTAS, nes importas ir būtų tas pats
BENCH-1 pažeidimas, dėl kurio persakymas atsirado; `ui-app` — dėl to, kad tai atskiras workspace
su savo toolchain'u.

Vartas turi DANTIS: `packageLiterals` reikalauja ne tuščios aibės. Be to pakeitus deklaracijos
formą abi pusės grąžintų `[]`, o `deepEqual([], [])` yra sutapimas be turinio — vartas, kurio
negalima sulaužyti, nėra vartas.

### Patikros po šešto rato

- `pnpm typecheck`, `pnpm lint` — praeina.
- `pnpm test` — **1569/1569** (+4); `pnpm test:ui` — 51/51 failai, **417/417**.

## Septintas ratas: ketvirtas gilus DTO ir mirusi kohorta (2026-08-24)

Penktame rate parašiau „trys likę gilūs DTO". Jų buvo **keturi** —
`/api/reliability-analytics` liko nesulygintas. Šis ratas jį uždaro ir taiso tai, ką sulyginimas
atidengė.

### Sulyginimas: ŠVARU

`ReliabilityAnalyticsResponse` serverio ir kliento pusės sutampa laukas į lauką, įskaitant visus
įdėtus tipus: `FileActivityBucket`, `FailureAnalytics` (su `byType`, `byDay`), `FailureRecord`
(13 laukų), `coverage`, `files.session/today/week`, `byExtension`.

Pastaba: šis endpoint'as VIENINTELIS kliente jau turėjo runtime patikrą
(`fetchReliabilityAnalytics` tikrina `reliability.byDay` ir `files.byDay`) — kažkas žinojo, kad
riba rizikinga. Patikra dengė 2 laukus iš ~20; dabar visą formą laiko sulyginimas.

### Radinys: kohorta, skaičiuojama kiekvienam pollui ir neskaitoma niekur — IŠTRINTA

`ReliabilityAnalyticsResponse.compressionCohorts` neturėjo **nė vieno** skaitytojo: nei `src/`,
nei `ui-app/` (kliento tipas jo net nedeklaravo). Bet jis buvo skaičiuojamas kiekvienam
`/api/reliability-analytics` kvietimui — o tą endpoint'ą dashboard'as pollina — ir keliaudavo į
naršyklę, kad būtų numestas.

Kaina buvo ne tik lauko dydis: kartu su juo egzistavo **visas `context-size-metrics.jsonl`
skaitymas ir parsinimas**, kuris daugiau niekam nereikalingas. Tai tas pats endpoint'as, kuriam
trečias ratas jau grąžino 10 s kešą (jis be reikalo sukdavo git subprocesus kas pollingą); čia
buvo antras to paties nereikalingo darbo sluoksnis.

**Kohortos NEDINGO.** `buildCompressionCohortReport` gyvas ir turi tikrą kvietėją —
`verqestra report`, kuris jas ir renderina. Ištrinta buvo ANTRA to paties skaičiavimo kopija.
Ankstesnis testas tvirtino tik `typeof response.compressionCohorts === "object"` — pats įrodymas,
kad kontrakto nebuvo; dabar testas pin'ina PAŠALINIMĄ.

Kartu pašalinta ir `coverage.limitations` eilutė apie canary vs control: atsakymui nebenešant
kohortų, apribojimas apie jas yra teiginys apie spragą, kurios nėra — būtent tas šablonas, kurį
šis repo jau užrašė kaip „pasenusi antraštė pavojingesnė už jokią".

### Patikros po septinto rato

- `pnpm typecheck` — praeina.
- `pnpm test` — 1582/1583. **Vienintelis kritimas priklauso lygiagrečiai sesijai**
  (`markdown-readers-real-corpus` — jos RAG audito 5 darbas). Visi UI testai žali.
