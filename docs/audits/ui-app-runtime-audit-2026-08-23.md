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

## Aštuntas ratas: per-srautinės grandinės (2026-08-24)

Aštuntas „mechanizmas be vartotojo" — ir pirmas, kuris ne tylėjo, o **melavo ekrane**.

### Ką serveris siunčia ir ko klientas neskaitė

`/api/events` krovinys nuo daugiaslot'inės bangos neša `slots[]` — kiekvieno gyvo srauto SAVO
agentų grandinę su `worker_id`, `task_id`, `attempt` ir `log_path`. Serverio `UiSlotActivity`
komentaras tiksliai pasako, kodėl jis atsirado:

> `AgentActivity` iki daugiaslot'inės bangos buvo projekcija ant VIENO globalaus log'o, kurį
> lygiagretūs worker'iai perrašo vienas per kitą. Antram slot'ui tai reiškė svetimą grandinę ir
> svetimą fazę.

Klientas šio lauko **nedeklaravo ir neskaitė**. `slotProgressViewModel` komentaras tai net
užrašė kaip prielaidą: „Vienas GLOBALUS `AgentActivity` srautas be `worker_id` — susieti su srautu
galima tik per užduotį." Ta prielaida nustojo galioti tada, kai serveris pradėjo siųsti `slots[]`.

### Pasekmė dviejų srautų bangoje

Grandinė buvo priskiriama spėjant: `correlateActivity` ieško slot'o, kurio `taskId` sutampa su
GLOBALIOS veiklos `taskId`. Bet globalus `claude-last.log` yra paskutinio rašytojo veidrodis, tad:

- srautas, kuris rašė paskutinis, gaudavo grandinę;
- **kitas srautas liko be grandinės ir su faze „nežinoma", nors dirbo**;
- dvi užduotys tuo pačiu vardu duodavo `ambiguous` — grandinės nerodė NIEKAS.

### Taisymas

Per-srautinis įrašas nuo šiol **nugali koreliaciją**: jis ateina iš to srauto bandymo log'o, tad
priskyrimo klausimo nebelieka. Iš to paties šaltinio imama ir `claudeStatus` — globalaus statuso
prikabinimas prie savo įrašą turinčio srauto būtų svetimo worker'io būsena.

Trys savybės, kurios yra šio surišimo kontraktas:

1. **Atgaliai suderinama.** Be `slots[]` (senas `dist`, tuščia banga) elgesys NEPAKITĘS — visi 417
   ankstesnių UI testų liko žali be pataisymų.
2. **`disconnected` nugali viską.** Nutrūkęs srautas panaikina priskyrimą net turint įrašus:
   skelbti „prisegta" iš pasenusių duomenų būtų tvirtinimas apie tai, ko nebežinome.
3. **Vienas kadras — vienas `setState` šaltinis.** Globalus aktyvumas ir `slots[]` imami iš TO
   PATIES kadro; du atskiri šaltiniai leistų akimirką rodyti naujo kadro grandinę su seno kadro
   slot'ais.

NELIESTA sąmoningai: `#/` „Active execution" panelė ir toliau rodo GLOBALIĄ grandinę su
`correlateActivity` atribucija. Ji rodo vieną grandinę, o per-srautinį vaizdą dabar duoda
`SlotStreamsOverview`; jos pakeitimas būtų dizaino sprendimas, ne defekto taisymas.

### Vartai (aštuntas ratas)

| Failas | Ką pin'ina |
|---|---|
| `ui-app/src/model/slotProgressViewModel.test.ts` (+4) | kiekvienas srautas gauna SAVO grandinę, ne paskutinio rašytojo; vienodi task vardai nebedaro priskyrimo dviprasmiško; be `slots[]` elgesys nepakitęs (tai ir dokumentuoja SENĄJĮ defektą); `disconnected` panaikina priskyrimą |

## Devintas ratas: „Gyvi duomenys" (2026-08-24) — OPERATORIAUS radinys

Pirmas šio audito radinys, atėjęs iš žmogaus, realiai žiūrinčio į ekraną, o ne iš kodo skaitymo:

> Apžvalga — gera, tačiau „Gyvi duomenys" konfliktuoja su pasenusia užduoties būsena.

### Šaknis nebuvo tekstas

`DashboardPage` rodė **besąlygišką literalą** `<span className="freshness-indicator">Live data</span>`.
Tai buvo tvirtinimas, kurio niekas netikrino: jis liko toks pat, kai SSE srautas nutrūkdavo, kai
paskutinis `/api/dashboard` atnaujinimas nepavykdavo ir kai duomenys buvo dešimties minučių senumo.

Tai TA PATI klasė, kurią šis auditas gaudo nuo pirmos dienos — neverifikuotas teiginys,
atvaizduotas kaip būsena. Ir tai buvo dashboard'o IŠIMTIS: `ReliabilityPage` tą patį
`freshness-indicator` jau rodė su tikra žyma (`Updated <data>`).

Operatoriaus pastebėtas konfliktas yra pasekmė. „Gyvi duomenys" ir „Pasenusi užduoties būsena" yra
DU SKIRTINGI faktai (dashboard'o kanalo šviežumas ir tai, ar `vq/state/current-task-id` atitinka
eilę), ir abu gali būti teisingi vienu metu. Bet ekranas nesakė, apie ką kiekvienas jų kalba, tad
skaitėsi kaip prieštaravimas.

### Taisymas: ženklelis užsitarnauja savo žodį

Naujas `FreshnessIndicator` su GRYNA `resolveFreshness` taisykle:

| Sąlyga | Verdiktas |
|---|---|
| paskutinis atnaujinimas nepavyko | `failed` — stipriausias signalas: ekranas nebeatitinka serverio, ir jokia srauto būsena to nepaneigia |
| dar nė karto nepavyko | `connecting` — ne melagingas šviežumas |
| nuo sėkmingo skaitymo praėjo > 75 s | `stale` — du praleisti 30 s ratai plius atsarga (vienas praleistas pollingas yra tinklo mikčiojimas) |
| SSE srautas nutrūkęs | `stale` — duomenys neteisingais netampa, bet žodis „gyvi" jiems nebepriklauso |
| kitaip | `live` |

Kartu ženklelis **įvardija savo dalyką**: rodomas duomenų amžius (`atnaujinta prieš 5s`), tad
matyti, kad kalbama apie kanalą, ne apie užduotį. Tonas seka verdiktą — „gyvi" ir „pasenę" negali
atrodyti vienodai, kitaip pasikeičia tik tekstas, o ekranas ir toliau atrodo ramus.

Laikas žymimas PRIEŠ „niekas nepasikeitė" grįžimą: ramus, nieko nekeičiantis ciklas yra šviežias
atsakymas, o ne nutrūkęs ryšys.

### Vartai (devintas ratas)

| Failas | Ką pin'ina |
|---|---|
| `ui-app/src/view/components/FreshnessIndicator.test.tsx` (naujas, 6) | `live` tik šviežiam pollingui su gyvu srautu; nepavykęs atnaujinimas nugali viską; nutrūkęs srautas atima šviežumą; vienas praleistas ratas dar NE `stale`, du — jau; be nė vieno sėkmingo skaitymo — `connecting`; amžius niekada neneigiamas |

### Patikros po devinto rato

- `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm lint` — praeina.
- `pnpm test` — **1590/1590**; `pnpm test:ui` — 52/52 failai, **427/427** (+6).
- `pnpm build:ui` — praeina.

## Dešimtas ratas: keturi OPERATORIAUS radiniai (2026-08-24)

Antras srautas radinių iš žmogaus, žiūrinčio į realų ekraną. Visi keturi tikri, ir vienas jų —
ne kosmetika.

### 1. Siauras ekranas PASLĖPDAVO ciklo, atnaujinimo ir temos veiksmus

> Siaura apžvalga — vizualiai gera, bet paslepiami ciklo, atnaujinimo ir temos veiksmai.

```css
@media (max-width: 760px) { header .toolbar > .button { display: none } }
```

Tai atimdavo **„Sustabdyti ciklą"** — vienintelį veiksmą, kurį UI leidžia BET KURIOJE būsenoje,
įskaitant `unknown` (paties repo taisyklė: stabdymas nekenksmingas, o antro orkestratoriaus
paleidimas — reali žala). Kartu dingdavo „Atnaujinti" ir temos jungiklis. Pakaitalo nebuvo jokio.

**Valdiklis, dingstantis be pakaitalo, yra tylus galimybės praradimas, ne prisitaikymas prie
ekrano.** Juosta nuo šiol LAUŽIASI ir gauna savo eilutę; paslėptas lieka tik dekoratyvus
skirtukas (`aria-hidden`), kuris laužomoje juostoje nieko neskirtų.

### 2. „Sistema veikia" prieš „1/3 vykdoma"

> Sistema — vidutinė; „Sistema veikia" konfliktuoja su „1/3 vykdoma".

`overall` skaičiuojamas iš DVIEJŲ faktų — ar veikia UI procesas ir ar nėra `unknown` būsenų —
o antraštė tvirtino „**All** observable runtime components are available". Sustabdytas ciklas į
verdiktą neįeina, tad ekrane vienu metu stovėdavo teiginys ir jį paneigiantis skaičius.

Tas pats šablonas kaip „Gyvi duomenys": **teiginys, platesnis už savo įrodymą.** Sakinys pakeistas
į tai, kas realiai patikrinta („sąsaja pasiekiama, ir kiekvienas komponentas pranešė apibrėžtą
būseną"), o šalia atsirado atskira **ciklo būsena** — nes `1/3` be jos skaitosi kaip gedimas,
nors sustabdytas ciklas ir nedirbantis vartotojo terminalas yra normalios būsenos. Trys procesai
NĖRA lygiaverčiai, ir jų sudėjimas į vieną santykį sulygina tai, kas nesulyginama.

### 3. Užduočių stulpeliai per siauri, vardai neįskaitomi

> Užduotys — reikia taisyti; stulpeliai per siauri, failų pavadinimai neįskaitomi.
> Siauros užduotys — prasta; dviejų stulpelių išdėstymas laužo tekstą.

Šaknis buvo užrašyta pačiame CSS komentare: `minmax(150px, 1fr)` pasirinkta tam, kad **visi
septyni bucket'ai tilptų į vieną eilutę**. Kaina — 11px šriftu telpa ~20 simbolių, o vardas yra
`0042-aprasomasis-slug.md`, tad `text-overflow: ellipsis` nukirsdavo būtent SLUG'ą, t. y.
vienintelę dalį, kuri vieną užduotį skiria nuo kitos.

Stulpelio minimumas nuo šiol yra **vardo reikalavimas, ne bucket'ų skaičiaus**: 260px, bucket'ai
persineša į dvi eilutes, horizontalaus slinkimo neatsiranda nė viename plotyje. Vardai
LAUŽIAMI (`overflow-wrap: anywhere`), o ne kerpami — nukirptas vardas atrodo kaip informacija,
bet jos neneša. `max-height` pakeltas kartu, kad dviejų eilučių įrašas perpus nesumažintų matomų
užduočių skaičiaus: vienas taisymas neturi pagimdyti kito trūkumo.

### 4. Pasikartojančios nulinės būsenos

> Peržiūros — gera, nors nulinės būsenos kartojamos.

Tuščiame `#/reviews` operatorius matydavo TRIS tą patį sakančius blokus: `ReviewSummary` sakinį,
`HumanReviewPanel` tuščią būseną ir `PolicyProposalsPanel` inbox-zero. Traukiasi tas, kuris neša
mažiausiai — hero sakinys; panelė žemiau tą patį pasako su kontekstu ir veiksmais. Skaičius lieka:
jis yra maršruto antraštė, ne pakartojimas.

### Patikros po dešimto rato

- `pnpm typecheck:ui`, `pnpm test:ui` (52/52 failai, **427/427**), `pnpm build:ui` — praeina.
- Serverio pusė šiame rate NELIESTA (pakeitimai tik `ui-app/`).

## Vienuoliktas ratas: operatoriaus pakeitimų sąrašas (2026-08-24)

Šeši nurodymai, ne radiniai — operatorius pasakė, ką keisti. Visi šeši padaryti.

### 1. Ryšys, šviežumas ir sveikata — TRYS atskiri ženklai

Devintame rate `FreshnessIndicator` SULIEJO du iš jų: nutrūkęs SSE srautas versdavo duomenis
„pasenusiais". Tai buvo klaida abiem kryptimis — `/api/dashboard` pollinimas veikia visiškai
nepriklausomai nuo SSE ir gali būti sėkmingas tą pačią sekundę, kai srautas krito.

Dabar: `resolveFreshness` mato TIK `refreshFailed` ir `loadedAt` (duomenų amžius), o srauto būsena
turi savo `StreamIndicator`. Sistemos sveikata čia neminima iš viso — ji gyvena `RuntimePanel`.

### 2. Mobiliajame ekrane — vienas užduočių stulpelis

`≤760px` `workflow-board` gauna `grid-template-columns: 1fr`. Du siauri stulpeliai laužė tekstą
per vidurį ir nesutaupė nieko: bucket'ų yra septyni, tad vertikalus sąrašas vis tiek slenkamas, o
vienas stulpelis kiekvienam duoda visą plotį.

### 3. Failai iki ID ir pavadinimo

Naujas grynas `taskFileLabel`: `0042-perkelti-loop.md` → `0042` + `perkelti loop`. Sudėtinis vaiko
ID (`0042-02`) lieka VIENAS vienetas — suskaldytas jis rodytų į tėvą. Vardas be skaitinio prefikso
ID NEĮGYJA: atlaidus „bet kas iki pirmo brūkšnelio" paverstų `readme-guard` ID `readme`.

**PILNAS vardas nedingsta** — jis lieka `title`. Tai skirtumas tarp trumpinimo ir informacijos
praradimo, ir testas pin'ina abi puses.

### 4. Mobilus „Daugiau" meniu

`MoreMenu` neša VISUS devynis ekranus ir įrankius (ciklo start/stop, atnaujinimas). Rodomas tik
`≤760px`, kur skirtukų slinkiklis yra ne navigacija, o slėptuvė: nematomas skirtukas neegzistuoja
tam, kas jo neieško. Ciklo veiksmai jame kartojasi SĄMONINGAI — juosta gali būti nuslinkusi, o
„Sustabdyti ciklą" negali tapti nepasiekiamu.

`<details>`, o ne savas dropdown'as: klaviatūra ir screen reader'iai jį moka be nė vienos `aria-*`
eilutės; pridėta tik tai, ko jam trūksta — uždarymas paspaudus šalia ir per `Escape`.

### 5. Tuščias srautas: stabdymas ir nutraukimas išjungti

`drain` ir `abort` veikia VYKDOMĄ bandymą; tuščiam srautui jie nekeičia nieko, tad aktyvus
mygtukas žadėjo veiksmą, kurio vienintelė galima pasekmė — tyla. „Tęsti" lieka aktyvus: juo
atrakinamas anksčiau sustabdytas srautas, ir tai yra veiksmas net be užduoties. Išjungimo
priežastis pasiekiama per `title` — išjungtas mygtukas be paaiškinimo yra mįslė.

**Testų pamoka:** keturi esami testai krito, ir jie buvo TEISŪS savo tikslu — jie tikrino
per-srautinį taikymą, o ne mygtuko būseną. Numatytasis fixture turėjo tuščią `w2`, tad po
pakeitimo jie būtų tikrinę išjungtą mygtuką. Sprendimas — atskiras `bothStreamsWorking()`
fixture toms patikroms; numatytasis liko nepaliestas, nes juo remiasi „No task assigned" atvejis.
Pirmas bandymas keisti BENDRĄ fixture'ą sulaužė būtent tą testą ir buvo atsuktas.

### 6. Paspaudimo taikiniai ≥ 44 px

`.button`, `.small-button`, `.nav-tab`, `.more-menu > summary`, `.more-menu-item` gauna
`min-height: 44px` (ir `min-width` mygtukams). 32–41px pakanka pelei, per maža pirštui — o tai
buvo būtent dažniausiai spaudžiami valdikliai (WCAG 2.5.8).

### Vartai (vienuoliktas ratas)

| Failas | Ką pin'ina |
|---|---|
| `ui-app/src/model/taskFileLabel.test.ts` (naujas, 6) | ID atskiriamas nuo pavadinimo; sudėtinis vaiko ID lieka vienetu; vardas be prefikso ID neįgyja; vardas be aprašomosios dalies grąžina ID, ne tuščią eilutę; kelias nukerpamas abiem separatoriais |
| `ui-app/src/view/components/LoopStreamCards.test.tsx` (+2) | tuščiame sraute `drain`/`abort` išjungti ir paspaudimas serverio nekviečia; priežastis pasiekiama; dirbantis srautas lieka valdomas |
| `FreshnessIndicator.test.tsx` (perrašytas) | srauto būsena šviežumo NEBELIEČIA |

### Patikros po vienuolikto rato

- `pnpm typecheck:ui`, `pnpm build:ui` — praeina.
- `pnpm test:ui` — **53/53 failai, 435/435** testai.
- `pnpm test` — **1603/1603**.

## Dvyliktas ratas: miręs kodas, dublikatai, logikos klaidos (2026-08-24)

Kitas audito tipas — higienos šluostė, ne kontraktai. Du radiniai uždaryti, keturios vietos
patikrintos ir pripažintos ŠVARIOMIS. Pastarosios užrašomos sąmoningai: „radau nulį" yra tokia
pat audito išvada kaip radinys, ir be jos kitas auditas tikrins tą patį iš naujo.

### Rasta: DVI to paties saugos sprendimo kopijos — SUVIENODINTA

„Kuriuos ciklo mygtukus leidžia būsena" buvo persakyta dviejose vietose: `buildLoopControlsView`
(`#/system`) ir `buildLoopControls` (Header). Kopijos JAU buvo prasilenkusios:

| Būsena | `#/system` | Header |
|---|---|---|
| `unknown` / `undefined` | paleidimas UŽDARYTAS | paleidimas **LEIDŽIAMAS** |

Header'io šaka rėmėsi pagrindimu „fresh project, loop never ran", kuris nebegalioja nuo pirmo šio
audito rato: serveris `runtime` sąrašą siunčia VISADA, tad „įrašo nėra" nebereiškia švaraus
projekto — jis reiškia netvarkingą atsakymą, kur paleidimo siūlyti tuo labiau negalima. Ir tai
prieštaravo paties failo antraštei, kuri sako, kad nežinomybėje paleidimas uždaromas, nes antras
orkestratorius tame pačiame repo yra reali žala.

Antras skirtumas buvo tylesnis: du ŠALTINIAI tam pačiam klausimui — Header skaitė
`runtime["AG loop"].status`, `#/system` — `loopRunStateOf` (kuris pirmenybę duoda
`loopControl.loop.status`). Nuo pirmo rato jie sutampa, bet tai mano pataisos atsitiktinumas, ne
garantija.

Dabar taisyklė VIENA (`loopActionAllowed`), šaltinis vienas, o naujas vartas tvirtina, kad Header
ir `#/system` atsako vienodai KIEKVIENAI būsenai — iki šiol abu tikrino tik savo pusę atskirai.

### Rasta: sąjungos narys, kurio wire negali atnešti — PAŠALINTA

`PolicyProposalRouting` kliente turėjo `"openspec"`, o serverio `z.enum(POLICY_ROUTINGS)` leidžia
tik `queue` ir `human-review`. Ne runtime klaida (perteklinis narys inertiškas), bet kvietimas
parašyti `if (routing === "openspec")` šaką, kuri niekada neįvyks ir atrodys kaip veikianti.

Naujas `src/tests/ui-restated-contracts.test.ts` dengia ŠEŠIAS persakytas sąjungas
(`TaskBucket`, `LoopSlotMode`, `LoopWorkerId`, `LoopSlotState`, `AgentStatus`,
`PolicyProposalRouting`). Kaip ir benchmark vartas, jis turi DANTIS: tuščia literalų aibė yra
klaida, nes `deepEqual([], [])` būtų sutapimas be turinio.

### Patikrinta ir ŠVARU

| Įtarimas | Verdiktas |
|---|---|
| `taskFileName` dviejuose failuose | **Ne dublikatas.** HTTP versija atmeta separatorių ir `..`, CLI versija apkarpo `basename` — dvi skirtingos saugos laikysenos dviem skirtingiems įvesties šaltiniams, ir skirtumas užrašytas vietoje |
| `filterTokenUsageRecords` abiejose laido pusėse | **Ne dublikatas.** Serveris filtruoja instantus, klientas prideda `task_id` substring paiešką, kurios serveris negali daryti |
| Datos ribos: serveris UTC para, klientas vietinė para | **Ne klaida.** `useTokenUsageController` datą paverčia vietinės paros ISO riba PRIEŠ užklausą, tad serveris gauna tikslų momentą ir jo neinterpretuoja; sulygiavimą jau laiko testas. Serverio pusėje užrašyta, kad plikas `YYYY-MM-DD` duoda UTC parą — kitiems klientams (mobile-gateway) tai KITAS langas |
| Mirę moduliai `ui-app/` | **Nėra.** Visi 60+ modulių turi importuotoją; `ui-model` ir `interfaces/http` eksportai turi kvietėjus |

### Patikros po dvylikto rato

- `pnpm test` — **1614/1614**; `pnpm test:ui` — 53/53 failai, **436/436**.
- `pnpm typecheck:ui` — praeina.

## Tryliktas ratas: „ar visi duomenys atvaizduojami ir visi API veikia?" (2026-08-24)

Operatoriaus klausimas. Atsakymas į pirmą dalį — **ne**, ir žemiau yra sąrašas.

### API: visi 21 maršrutas turi kvietėją

Dešimt `GET` ir vienuolika `POST`. Kiekvienas turi klientą, o jų atsakymų formos sulygintos
antrame rate (vokai) ir penktame–šeštame (gilūs DTO). Vienintelė išimtis — `/api/logs`, kurio
`ui-app` nekviečia SĄMONINGAI: jis pridėtas `mobile-gateway` adapteriui.

### Duomenys: maždaug trečdalis krovinio niekur nerodomas

`/api/dashboard` kas 30 s siunčia laukus, kuriuos klientas numeta:

| Laukas | Būsena |
|---|---|
| `stopStatusSource`, `stopStatusCorrupted` | **IŠTAISYTA šiame rate** — žr. žemiau |
| `stableRef`, `claudeLogUpdatedAt` (per `claudeResume.updated_at`) | patenka į apžvalgos metrikas #5–#6, kurias `OverviewPanel metrics={overview.slice(0, 4)}` nukerpa |
| `claudeLogBytes`, `claudeLogSource` | be vartotojo (`logBytes` ištrintas trečiame rate) |
| `queueCounts`, `statusFiles` | be vartotojo |
| `supervisorResume` | tik validuojamas kontrakto patikroje, niekur nerodomas |
| `controlPlane.config_controls` | be vartotojo — git automatikos valdikliai neturi panelės |
| `controlPlane.loop_controls` | be vartotojo — klientas ciklo maršrutus žino pats |
| `controlPlane.stack_decision` | be vartotojo |
| `controlPlane.live_slots` | be vartotojo (aštuntame rate prijungtas SSE `slots[]`, ne šis) |
| `controlPlane.token_budget` | be vartotojo — `buildSlotProgressViews` `budgets` sąmoningai negauna |
| benchmark `report.compression` | be vartotojo (šeštas ratas) |

Didžioji dalis jų yra **nepadarytos funkcijos**, ne klaidos: kad `token_budget` būtų rodomas,
reikia biudžeto juostos; kad `config_controls` — git politikos panelės. Tai produkto darbas, ne
audito, ir jis įvardytas, o ne tyliai padarytas.

### IŠTAISYTA: kodo paties pažadas, kurio jis nevykdė

`stopStatusSource` serveryje turi komentarą „kilmė rodoma, o ne nutylima", o `stopStatusCorrupted`
reiškia, kad įrodymas RASTAS, bet neperskaitomas — būseną, kurioje serveris SĄMONINGAI nenusileidžia
prie globalaus veidrodžio. Klientas nė vieno jų neskaitė, tad:

- sugadintas įrodymas ekrane atrodė kaip tuščias `pending` — priešingas faktas;
- `legacy` kilmė (įrodymas gali priklausyti KITAM task'ui) buvo nematoma, ir operatorius darydavo
  išvadą iš svetimo įrodymo to nežinodamas.

Dabar: sugadintas įrodymas gauna savo etiketę ir `error` toną, o kilmė — `title`. Senas `dist` be
šių laukų elgesio nekeičia.

### Patikros po trylikto rato

- `pnpm test` — **1617/1617**; `pnpm test:ui` — 53/53 failai, **439/439** (+3).
- `pnpm typecheck:ui`, `pnpm build:ui` — praeina.

## Keturioliktas ratas: „viskas matoma ir veikia" (2026-08-24)

Trylikto rato inventorius pavirto darbu. Taisyklė, pagal kurią jis darytas: **kiekvienas laukas
arba matomas ekrane, arba nebesiunčiamas.** Trečio kelio — „siunčiam, gal kada prireiks" — nebėra.

### Padaryta MATOMA

| Laukas | Kur dabar matomas |
|---|---|
| `stableRef`, `claudeResume.updated_at` | apžvalga rodo VISAS 6 metrikas (buvo `.slice(0, 4)`) |
| `controlPlane.token_budget` | naujas `TokenBudgetPanel` (`#/system`) |
| `statusFiles`, `claudeLogUpdatedAt/Bytes/Source`, `supervisorResume`, `claudeResume`, `config_controls`, `stack_decision` | naujas `DiagnosticsPanel` (`#/system`) |

`TokenBudgetPanel` buvo brangiausias praradimas: jis vienintelis atsako, **kodėl** dispatch'as
pristabdytas ar neleistas. Du blokai jame nesuliejami — juos rašo skirtingi momentai, ir bendras
skaičius iš dviejų laiko taškų meluotų apie abu. Priežastys rodomos KAIP KODAI (`max_total_tokens_exceeded`),
nes būtent jų ieškoma žurnale; `null` riba rodoma kaip „neribota", o ne kaip nulis.

`DiagnosticsPanel` renderina įrodymą PAŽODŽIUI, tad gauna `raw` atsakymą, o ne vaizdo modelį:
adapteris čia tik kopijuotų laukus, pridėdamas sluoksnį, kuriame galima suklysti.

### Padaryta NEBESIUNČIAMA

| Laukas | Kodėl pašalintas |
|---|---|
| `queueCounts` | `workflowBuckets[].totalCount` perrašymas kitu raktu; klientas skaitė `totalCount`. Du to paties skaičiaus pavidalai viename atsakyme anksčiau ar vėliau prasilenkia |
| `controlPlane.loop_controls` | siuntė maršrutus, kuriuos klientas turi savo `api.ts` ir skaito iš ten. Nenaudojamas endpoint'as atsakyme atrodo kaip autoritetas — pervadinus maršrutą kiltų pagunda taisyti jį, o realus kelias liktų senas |
| `controlPlane.live_slots` | **miręs laukas IR kelio nutekėjimas** — žr. žemiau |

### `live_slots`: blogiausias derinys

Laukas nešė `worktree_path` — ABSOLIUTŲ darbo kopijos kelią — tiesiai į naršyklę kas 30 s, ir jo
neskaitė niekas. `ui-waves-view` tą patį duomenį sąmoningai sumažina iki `has_worktree` vėliavos su
komentaru „pats kelias sąmoningai neatskleidžiamas"; šis kelias tos taisyklės nepaisė.

Vykdymo priskyrimas nedingo: `deriveLoopSlots` snapshot'o `live_slots` toliau naudoja kaip
autoritetą, tik DTO susiaurintas iki `{worker_id, task_id, attempt}` — be `started_at` (jo niekas
nerodo) ir be `worktree_path`.

### Ko nepadariau keturioliktame rate (uždaryta penkioliktame)

Benchmark `report.compression` liko nerodomas. Uždaryta 2026-08-24 — žr. penkioliktą ratą.

### Vartai (keturioliktas ratas)

| Failas | Ką pin'ina |
|---|---|
| `ui-app/src/view/components/DiagnosticsPanel.test.tsx` (naujas, 5) | būsenos failai (įsk. nesamą, kuris LIEKA sąraše), log kilmė, tęsimo taškai, stack sprendimo priežastis, automatikos politika; biudžetas be verdikto sako TAI, o ne rodo nulius; priežastys rodomos kaip kodai; `null` riba yra „neribota" |
| `src/tests/composition-ui-dashboard-contract.test.ts` (+4) | `loop_controls`, `live_slots`, `queueCounts` PAŠALINTI ir negrįžta; `worktree_path` neišeina į naršyklę |

Paskutinis vartas svarbus dėl to, ką jis draudžia: be jo pašalinti laukai grįžtų kaip „naudingas
kontekstas", o kelio nutekėjimas kartu su jais.

### Pamoka apie testus ir build'ą

Kliento tipo pakeitimas praėjo pro 444 vitest testus ir krito ties `pnpm build:ui`: vitest
transformuoja per esbuild BE pilno tipų tikrinimo, o `tsc -b` — su. **Žali testai `ui-app` pakete
NEĮRODO, kad tipai suveda** — `typecheck:ui` ir `build:ui` yra atskiri vartai, ir juos reikia
paleisti abu.

### Patikros po keturiolikto rato

- `pnpm test` — **1617/1617**; `pnpm test:ui` — **54/54 failai, 444/444**.
- `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm build:ui` — praeina.

### Patikros po aštunto rato

- `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm lint` — praeina.
- `pnpm test` — **1587/1587**; `pnpm test:ui` — 51/51 failai, **421/421** (+4).
- `pnpm build:ui` — praeina.

---

## Penkioliktas ratas (2026-08-24) — kompresijos kohorta ir klasė „laukas atkeliauja, bet nematomas"

### Radinys: visas eksperimentas nematomas

`AG/benchmark` nuo BENCH-10 skaičiuoja `report.compression` — canary vs control kohortą, kuri yra
**vienintelė vieta, kur kompresijos nauda apskritai falsifikuojama**. Serveris tą dokumentą
persiunčia pažodžiui (`looseObject`, `modes: z.array(z.unknown())`), tad sekcija į naršyklę
keliavo visą laiką. Klientas neturėjo net jos TIPO, todėl ekrane jos nebuvo: kas ją matė, matė
tik terminale.

Tai atskira defektų klasė nuo ankstesnių ratų: ne „laukas nesutampa" ir ne „mechanizmas be
kvietėjo", o **laukas, kuris atkeliauja tvarkingai ir nėra nuskaitomas**. Pažodinis persiuntimas
reiškia, kad tokio praleidimo NIEKAS nesignalizuoja — nei schema, nei tipai, nei testai.

### Ką panelė teigia ir ko neteigia

`ui-app/src/view/components/CompressionCohortPanel.tsx` neperskaičiuoja nė vieno skaičiaus:
deltas, rodiklius ir verdiktą suveda paketas. Trys taisyklės, kurios yra jos kontraktas:

| Taisyklė | Kodėl |
|---|---|
| **Nematuota ≠ nulis** | `undefined` KPI rodomas kaip „—". Nulis reikštų IŠMATUOTĄ nulinę kainą — tiksliai priešingą teiginį nei „duomenų nėra" |
| **Priežastys — kodai** | Verdikto priežastys neverčiamos ir neperfrazuojamos: būtent jų ieškoma ataskaitoje ir žurnale |
| **Apribojimai visada matomi** | Sekcija, parodyta be to, ko ji negali teigti, perskaitoma kaip įrodymas, kurio ji neneša |

Iš tos pačios logikos plaukia dar du sprendimai. Nesuvesta kohorta (`compression` nėra) **nieko
nepiešia** — tuščia lentelė būtų perskaityta kaip „kompresija nieko nedavė", o tai kitas teiginys
nei „niekas nematavo". Ir funkcijos, kurios vieno požymio variantas nepaleistas, indėlis rodomas
kaip „nepaleista", o ne išvedamas atimtimi iš derinio: tai paskelbtų aritmetinę tapatybę kaip
matavimą.

Ženklų kryptys paliktos tokios, kokias suvedė paketas, ir įvardytos ekrane: lentelės delta yra
`variantas − baseline` (neigiama = pigiau, todėl žalia), o funkcijos indėlis — `baseline −
variantas` (teigiama = neišleisti tokenai). Suvienodinus jas „kad būtų gražiau", viena pusė būtų
skaitoma atbulai.

### Trys laukai, kurių tipas neturėjo

Rašant vartą paaiškėjo, kad pirmoji kliento tipo redakcija praleido
`rawTokensPerAcceptedTaskRelativeDelta`, `diagnostics` ir visą `combination` bloką — t. y. per tą
pačią spragą, kurią ratas uždarinėjo. Pridėti visi; `combination` (funkcijų indėliai ir sąveikos
likutis) dabar turi savo bloką.

### Radinys pakeliui: `.table-scroll` be nė vienos taisyklės

Klasė naudojama PENKIOSE `#/benchmark` lentelėse ir CSS'e neturėjo jokio įrašo — pažadėjo
slinkimą ir jo neteikė, tad plati lentelė stumdavo visą puslapį horizontaliai. Tiksliai tas
gedimas, kurį operatorius aprašė siaurame ekrane, tik kitame ekrane nei tada tikrinta. Pridėta
`max-width: 100%; overflow-x: auto`.

### Vartai (penkioliktas ratas)

| Failas | Ką pin'ina |
|---|---|
| `src/tests/benchmark-restated-contracts.test.ts` (+2) | `COMPRESSION_VERDICTS` ↔ `BenchmarkCompressionVerdict`; ir **visi** `ReportCompressionVariantRow` laukų vardai turi turėti atitikmenį kliento tipe |
| `ui-app/src/view/components/CompressionCohortPanel.test.tsx` (naujas, 6) | tyla be sekcijos; „—" vietoje nulio; priežastys kaip kodai; nepriskirti bandymai įvardijami; apribojimai rodomi; nepaleisto varianto indėlis neišvedamas |

Antrasis serverio vartas svarbus dėl to, ką jis gaudo: pažodinis persiuntimas praleisto lauko
nesignalizuoja, tad **vienintelis būdas pastebėti naują paketo lauką yra sulyginti vardus**.
Paketui pridėjus stulpelį, vartas krenta su „atkeliauja, bet ekrane nematomi".

### Patikros po penkiolikto rato

- `pnpm test` — **1619/1619** (+2); `pnpm test:ui` — **55/55 failai, 450/450** (+6).
- `pnpm typecheck:ui`, `pnpm run build:ui` — praeina.

---

## Šešioliktas ratas (2026-08-24) — pakartotinis „ar visi duomenys matomi ir API veikia?"

Tas pats klausimas, užduotas po penkiolikos ratų. Atsakymas nebuvo „taip": inventorius perbėgtas
iš naujo — kiekvieno maršruto kvietėjas ir kiekvieno lauko vartotojas — ir rasti keturi dalykai,
kurių ankstesni ratai nepasiekė, nes jie gyvena NE dashboard'o krovinyje.

### API: 21 maršrutas, visi turi kvietėją

| Maršrutas | Kvietėjas |
|---|---|
| GET `/api/{dashboard,events,tasks,waves,policies/proposals,token-usage,token-analytics,reliability-analytics,benchmark/report}` | `ui-app` kontroleriai ir `api.ts` |
| GET `/api/identity` | prievado zondas (`composition/ui`) — skiria „mūsų serveris" nuo svetimo proceso |
| GET `/api/logs` | `mobile-gateway` — `ui-app` jo nekviečia SĄMONINGAI |
| POST `/tasks/{queue/upload,resume,stop}`, `/api/runtime/{workers,loop/start,loop/slots/<id>}`, `/api/tasks/<action>/<ref>`, `/api/policies/proposals/{approve,reject,apply}` | `api.ts` |
| POST `/api/policies/<grupė>/set` | `PolicyControlsPanel` per `control.route` — kelią duoda pats serveris |

Formas laiko `interfaces-http-router-contracts` ir `composition-ui-dashboard-contract`.

### Duomenys: keturi radiniai

**1. Tęsimo taškas nesako, KIENO jis.** `run-coordinator.ts:233` prieš praleisdamas preflight'ą
tikrina `supervisorResume.task_id === state.taskId`, o nesutapimą traktuoja kaip ŠVARŲ STARTĄ.
Ekranas rodė tik `status`, tad operatorius matydavo „finished" ir darydavo išvadą apie dabartinę
užduotį iš KITO task'o įrašo. Tai lygiai ta pati klaida, kurią trylikas ratas uždarė žurnalo
antspaudui (`claudeLogSource: legacy`) — tik čia ji liko atvira. Nematomos buvo ir `phase`
(kurią variklis skaito tiesiogiai) bei abu `updated_at`.

Priskyrimas rodomas TIK kai jis prieštarauja: įspėjimas apie sutampantį task'ą mokytų ignoruoti
įspėjimus. Checkpoint'as be `task_id` NĖRA nesutapimas — visi laukai optional, failas rašomas
palaipsniui, ir teigti apie jį „priklauso kitam task'ui" reikštų tvirtinti tai, ko nežinome.

**2. `total_cost_usd` — tikroji kaina — niekada nerodyta.** Visas `#/analytics` ekranas yra apie
kainą, o vienintelis doleriais išreikštas laukas telemetrijoje keliavo neperskaitytas. Sumuojama
TIK iš įrašų, kurie ją turi, ir `costRecords` stovi šalia: dalinai kainuota imtis kitaip skaitoma
kaip visa sąskaita. Eilutė nerodoma, kai kainos neturi nė vienas įrašas — `$0.00` iš nekainuotos
imties yra išmatuotas teiginys apie nemokamą darbą.

**3. `retry_reason` — kodėl kartota — niekada nerodytas.** Ekranas sakė KIEK kartų kartota. 40
pakartojimų dėl `rate-limit` ir 40 dėl `gate-failed` reikalauja priešingų veiksmų, tad „kiek" be
„kodėl" nurodo, kad problema yra, bet ne kur ji yra. Priežastis renkama iš BET KURIOS fazės ir
nepriklausomai nuo `attempt`: susiaurinus dingtų būtent tie atvejai, kur `attempt` neužpildytas —
t. y. ta pati dengiamumo spraga, kurią rodiklis ir matuoja. Kodai neverčiami.

**4. Pasenusi antraštė, prieštaraujanti savo kūnui.** `computeReworkProxyStats` JSDoc teigė, kad
„telemetrija neturi retry/failed-outcome lauko", o funkcija abu skaito septyniomis eilutėmis
žemiau ir grąžina `exactRetryTokens`/`failedRetryAttempts`/`isExact`. Antraštė siuntė skaitytoją
perstatinėti proxy tam, ką galima suskaičiuoti tiksliai. Perrašyta: tikroji riba yra
DENGIAMUMAS, ne buvimas.

### Pašalinta: `envOverride`

`WorkerRequestState.envOverride` visada lygus `source === "env"`, keliavo kas 30 s, ir jo neskaitė
NIEKAS — nei `src/`, nei `ui-app` (klientas `canEdit` išveda iš `source`). Laukas, kuris tik
rašomas ir niekada neskaitomas, yra `queueCounts` klasė: du to paties fakto pavidalai viename
įraše anksčiau ar vėliau prasilenkia, o prasilenkę nepasako, kuris teisus. Pašalinta iš visų trijų
sluoksnių (`application/scheduling`, `interfaces/http`, `ui-app` tipų).

### Vartai (šešioliktas ratas)

| Failas | Ką pin'ina |
|---|---|
| `DiagnosticsPanel.test.tsx` (+2) | svetimas tęsimo taškas pavadinamas; sutampantis NETRIUKŠMAUJA; checkpoint'as be `task_id` nėra nesutapimas |
| `tokenUsageViewModel.test.ts` (+4) | kaina sumuojama tik iš kainuotų įrašų su vardikliu; nekainuota imtis duoda `costRecords === 0`, ne nulinę kainą; priežastys rūšiuojamos pagal dažnį ir renkamos be `attempt` |
| `application-loop-control-store.test.ts` (griežtinta) | `deepEqual` be `envOverride` — antras pavidalas negrįžta |
| `composition-ui-dashboard-contract.test.ts` (+2) | `envOverride` neišeina į naršyklę, `source` lieka |

### Patikros po šešiolikto rato

- `pnpm test:only` — **1629/1629**; `pnpm lint` — švarus; `pnpm test:ui` — **55/55 failai, 456/456** (+6).
- `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm run build:ui` — praeina.
- Tarpiniuose bėgimuose matyti svetimi kritimai (`shared-owned-lock`, `contract-mobile-dashboard`,
  `characterization-code-index`), atsirandantys ir dingstantys tarp bėgimų — lygiagreti sesija
  commit'ina to paties bėgimo metu. Nė vienas jų nėra šio rato failuose.

---

## Septynioliktas ratas (2026-08-24) — šeši operatoriaus radiniai iš ekrano

Visi šeši uždaryti. Keturiuose iš jų šaknis buvo NE ta, kurią rodė simptomas.

### P1 — „Srautas gyvas" prieštarauja sustabdytam ciklui

Ženklas visą laiką sakė tiesą apie `/api/events` ryšį. Prasilenkė ŽODIS: lietuviškai „srautas"
šiame produkte jau reiškia ciklo slot'ą — „Ciklo srautai", „Stabdyti visus srautus", „Srautas 1".
Todėl „Srautas gyvas" prie nulio veikiančių slot'ų skambėjo kaip teiginys, kad ciklas dirba.

Vienuoliktas ratas atskyrė tris faktus (šviežumas / ryšys / sveikata) ir tai buvo teisinga; ko jis
nepadarė — nepatikrino, ar lietuviškas ženklo vardas neužima jau užimtos vietos. Ženklas dabar
vadinasi „Ryšys gyvas / Jungiamasi / Ryšys nutrūkęs". Tikslus daiktavardis yra visas taisymas.

### P1 — „Sistema veikia" prieštarauja 1/3

Dešimtas ratas šį patį konfliktą jau taisė — bet pakeitė tik SAKINĮ po antrašte, o skaitomas
dydis ekrane yra H2. `overall` remiasi TIK dviem faktais: ar veikia UI procesas ir ar nėra
`unknown` būsenų; sustabdytas ciklas į verdiktą neįeina. Antraštė dabar įvardija tai, ką realiai
patikrino — „Valdymo sąsaja pasiekiama". Ji ir „Ciklas: sustabdytas" viena kitai neprieštarauja.

**Pamoka:** taisant „teiginys platesnis už savo įrodymą", taisyti reikia DIDŽIAUSIĄ teiginį
puslapyje, ne pirmą rastą.

### P1 — mobili lipni antraštė 230 px (27,3 % ekrano)

Tai buvo trys sudėtos eilutės: prekės ženklas, laužoma įrankių juosta ir devynių skirtukų
slinkiklis. Lipnaus elemento kaina mokama visą laiką, tad jame liko tik tai, be ko negalima
dirbti: kuriame ekrane esu ir kaip patekti į bet kurį kitą (~56 px).

Skirtukai ir juosta siaurame ekrane paslepiami — o tai TIKSLIAI tai, ką dešimtas ratas įvardijo
kaip klaidą. Skirtumas vienas ir esminis: tada pakaitalo nebuvo, dabar „Daugiau" meniu neša
visus devynis ekranus, ciklo veiksmus, atnaujinimą, o kartu su šiuo ratu — ir temą bei kalbą.
Be tų dviejų priedų slėpimas būtų buvęs ta pati klaida iš naujo.

### P2 — tuščia peržiūrų būsena nustumia politikas

`.inbox-zero` buvo ~170 px centruota „herojinė" tuštuma, sakanti vieną dalyką: čia nieko nėra.
`#/reviews` prieš politikų valdiklius stovi dvi tokios. Dešimtas ratas sprendė tai TRINDAMAS
vieną iš trijų blokų; likusios dvi parodė, kad problema ne kiekis, o dydis. Dabar tai eilutė
(~52 px). Benchmark'o „ataskaitos nėra" blokas lieka stulpeliu — jis neša komandą, kurią reikia
paleisti, ir eilutei per platus.

### P2 — angliški stulpelių pavadinimai

Priežastis NEBUVO trūkstamas `t()` — jį turi visi `<th>`. `t()` nerastą raktą grąžina tokį, koks
jis yra, tad praleistas vertimas atrodo lygiai kaip veikiantis kodas. Tyliai degraduojantis
fallback teisingas runtime'e ir bevertis kaip signalas, todėl signalas pastatytas atskirai:
naujas `ui-app/src/i18n/coverage.test.ts` skaito visus `t("…")` literalus ir lygina su žodynu.
Jis rado tiksliai tris: `Value` (diagnostikos stulpelis — būtent tas, kurį matė operatorius) ir
du `HumanReviewPanel` sakinius. Visi išversti.

### P2 — dingstančios lietuviškos raidės

Šaknis yra `taskSlug`: `[^a-z0-9]` kiekvieną `ą č ę ė į š ų ū ž` vertė brūkšneliu, tad iš
„sąrašą" likdavo `s-ra`. Raidės ne pakeičiamos, o iškrenta, ir žodis nustoja būti žodžiu.

Taisymas — transliteracija, ne ne-ASCII failų vardai: `Įvardyti sąrašą` → `ivardyti-sarasa`.
Vardai lieka ASCII (jie keliauja per git, Windows ir POSIX), o žodis lieka perskaitomas.

**Regresija, kurios reikėjo išvengti:** `converge` ieško plano užduočių per `file.includes(slug)`.
Pakeitus taisyklę, kiekviena JAU sukurta lietuviška užduotis būtų paskelbta dingusia. Todėl
`taskSlugCandidates` grąžina abi formas, ir atpažinimas priima abi; kūrimas naudoja tik naują, o
nė vienas failas nepervadinamas.

### P2 — politikos forma

Du dalykai viename: „Siųsti" buvo išjungtas be paaiškinimo (vienintelis ženklas, kad trūksta
priežasties, buvo pats išjungtas mygtukas — reikalavimas, kurį reikėjo atspėti), o laukų vardus
nešė `placeholder`, dingstantis vos pradėjus rašyti. Dabar etiketės matomos, priežastis pažymėta
privaloma ten, kur jos prašoma, o išjungtas mygtukas turi ir `title`, ir tekstą po juo. Prieinamas
vardas nenukentėjo: `aria-labelledby` surenka valdiklio vardą ir lauko etiketę.

### P2 — LT/EN 27–30 px

Vienuoliktas ratas įvedė `.button { min-width: 44px }`. Jį TYLIAI nutildė dvi specifiškesnės to
paties failo taisyklės: `header .toolbar .button { min-width: 0 }` ir
`.language-switch .button { min-width: 36px }`. Abi laimėdavo pagal specifiškumą, tad vartas
buvo įrašytas ir neveikė nuo pirmos dienos — operatoriaus išmatuoti 27–30 px yra tikslus to
rezultatas.

**Pamoka:** CSS vartas, kurį gali nutildyti kita to paties failo taisyklė, nėra vartas. Skirtingai
nuo testų, čia niekas nekrenta.

### Vartai (septynioliktas ratas)

| Failas | Ką pin'ina |
|---|---|
| `ui-app/src/i18n/coverage.test.ts` (naujas, 2) | kiekvienas šaltinyje užrašytas `t("…")` raktas turi lietuvišką vertimą; tuščias parse yra klaida |
| `src/tests/domain-tasks.test.ts` (+4) | transliteracija išsaugo `ą į ž ū š`; ASCII vardui kandidatas VIENAS, lietuviškam — DU |
| `RuntimePanel.test.tsx` (griežtinta) | antraštė įvardija patikrintą dalyką, ne „sistemą" |
| `PolicyControlsPanel.test.tsx` (griežtinta) | laukai pasiekiami per MATOMŲ etikečių sudarytą vardą |

### Patikros po septynioliktojo rato

- `pnpm test:only` — **1631/1631**; `pnpm lint` — švarus.
- `pnpm test:ui` — **56/56 failai, 458/458**.
- `pnpm typecheck`, `pnpm typecheck:ui`, `pnpm run build:ui` — praeina.
