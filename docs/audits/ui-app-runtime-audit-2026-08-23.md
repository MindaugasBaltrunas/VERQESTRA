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

### Patikros po pataisymo

- `pnpm typecheck` — praeina.
- `pnpm lint` — praeina.
- `pnpm test` — praeina, 1484/1484 (buvo 1473; +11).
- `pnpm typecheck:ui` — praeina.
- `pnpm test:ui` — praeina, 48/48 failai ir 402/402 testai (buvo 46/393; +2 failai, +9 testai).
- `pnpm build:ui` — praeina, 94 moduliai.
