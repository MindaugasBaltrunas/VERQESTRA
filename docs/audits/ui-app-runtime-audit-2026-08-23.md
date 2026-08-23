# UI app paleidimo auditas — 2026-08-23

## Verdiktas

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
