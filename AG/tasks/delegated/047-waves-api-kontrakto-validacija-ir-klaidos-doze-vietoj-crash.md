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

## Žingsnis 0 — ar jau įgyvendinta?
Jei `fetchWaves` atsakymą validuoja per `requireContractFields` (kaip visi kiti
fetch'ai `api.ts`), `WavesPanel` turi `loading` būseną ir klaidos atveju NEpakeičia
paskutinių sėkmingų duomenų klaidos dėže — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas: `#/system` ekranas gali nulūžti tyliai. (a) `fetchWaves`
(`ui-app/src/api.ts:105-109`) daro žalią `as UiWavesView` be kontrakto patikros —
atsakymas be `degraded`/`leases` meta `TypeError` `WavesPanel.tsx:92` ir numuša visą
ekraną. (b) `useWavesController` (`useWavesController.ts:34-45`) neturi `loading` —
„Bandyti dar kartą" paspaudus 30 s nieko nevyksta. (c) Klaidos atveju panelė
pakeičia VISUS matytus duomenis klaidos dėže (`WavesPanel.tsx:58-70`).

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/api.ts`
- `ui-app/src/controller/useWavesController.ts`
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/tests/**`

Draudžiama:
- `src/**`
- `ui-app/src/view/pages/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `api.ts`: `fetchWaves` validuoti per `requireContractFields` (laukai: `degraded`,
  `leases`, ir kiti, kuriuos `WavesPanel` skaito besąlygiškai).
- `useWavesController.ts`: pridėti `loading` lauką; `reload` metu jis `true`.
- `WavesPanel.tsx`: rodyti `loading` indikatorių ant „Bandyti dar kartą"; klaidą
  rodyti JUOSTA virš paskutinių sėkmingų duomenų, o ne vietoj jų.
- Testai: kontrakto pažeidimas → klaidos būsena (ne throw); klaida nepanaikina
  ankstesnių duomenų.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti serverio
`src/interfaces/http/**` kontraktą — tai atskiras task'as.

## Neįtraukta
Negyvo vidinio kontrolerio šalinimas iš WavesPanel (053). Serverio pusės keitimai.
