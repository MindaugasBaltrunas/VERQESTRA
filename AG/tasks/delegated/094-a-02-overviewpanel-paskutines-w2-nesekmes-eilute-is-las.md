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
Uždaryti trečiąjį 065-b-03 signalą — paskutinę w2 nesėkmę. Vykdyti TIK po to, kai pirma 094 dalis (w2 gyvas + bangos režimas) jau sumerginta: šis darbas plečia tą patį `OverviewPanel.tsx`.

Tikslių `merged` / `parked: <priežastis>` / `child exit <kodas>` reikšmių dabartiniai UI tipai NEATIDUODA. Artimiausias esamas laukas — `SlotProgressView.lastError` (`ts`, `taskId`, `reason`), kilęs iš `UiWaveSlot.last_failure`; jis neša tik laisvo teksto priežastį, be exit kodo ir be „merged" vs „parked" skirties. Todėl rodoma SUMAŽINTA semantika, o ne spėjimas.

Jei `OverviewPanel.tsx` jau turi šaką, skaitančią w2 įrašo `lastError`, ir `OverviewPanel.test.tsx` turi tai dengiantį testą — ALREADY_IMPLEMENTED: nurodyk `failas:eilutė` abiem.

## Agentai
PRIVALOMA grandinė (readme-guard pirmas): readme-guard -> coder -> reviewer -> i18n -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/OverviewPanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `OverviewPanel.tsx`: iš jau paduodamo `slotProgress` paimti w2 įrašą; jei jo `lastError !== null`, pridėti dar vieną `OverviewMetric`-formos įrašą, kurio reikšmė yra `lastError.reason`. Kai `lastError === null` arba w2 įrašo nėra — eilutė NErodoma (sėkmės atvejo atskirti negalima, tad nerodyti sąžiningiau nei spėti).
- Etiketė NEVARTOJA žodžių „merged", „parked", „child exit" — jie implikuotų tikslumą, kurio duomenys neturi; naudoti neutralią formuluotę (pvz. „W2 last failure") ir pridėti jai EN+LT raktų porą `I18nContext.tsx`.
- `dashboard.css` keisti TIK jei atsiranda nauja `className`; kitu atveju nekeisti ir pažymėti ataskaitoje. `OverviewPanel.test.tsx` papildyti dviem atvejais: w2 su `lastError` (rodoma `reason`), w2 be `lastError` (eilutės nėra).

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

Commit tik kai abi žalios (`pnpm test` savyje suka ir ui-app typecheck bei testus).

## Stop
Sustok ir klausk, jei: tiksliai baigties priežasčiai (parked / child exit kodas) reikėtų `src/**` arba `ui-app/src/model/**` pakeitimo — tai atskiro serverio kontrakto darbo sritis, ne šios užduoties; arba `SlotProgressView.lastError` realiai neturi `reason` lauko.

## Neįtraukta
- `src/composition/loop/child-exit-diagnostics.ts` eksponavimas UI tipams.
- `merged` / `parked` / `child exit <kodas>` tikslių reikšmių įvedimas.
- Bet koks `DashboardPage.tsx` keitimas — props jau prijungti pirmoje dalyje.
