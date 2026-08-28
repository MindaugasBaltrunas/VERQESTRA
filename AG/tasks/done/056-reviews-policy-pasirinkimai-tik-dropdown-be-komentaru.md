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
Sukurti bendrinį valdomą `SelectMenu` dropdown komponentą (custom trigger + popover listbox, ne plikas `<select>`) su pilnu ARIA listbox šablonu, klaviatūros valdymu ir aukštos klasės vizualiniu stiliumi (chevron, pažymėto varianto ženklelis, subtilus šešėlis, 6–8px radius, ryškus focus žiedas, hover, ~120ms atsidarymo animacija). Šioje užduotyje komponentas dar niekur neprijungiamas.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/SelectMenu.tsx`
- `ui-app/src/view/components/SelectMenu.test.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/App.tsx`
- `ui-app/src/controller/`
- `ui-app/src/model/api.ts`
- `src/`
- `dist/`
- `node_modules/`

## Veiksmas
- Sukurti `SelectMenu.tsx`: valdomas API (`value`, `onChange`, `options`, `disabled`, `id`, `aria-label`), variantas su neprivalomu `tag` lauku (pvz. „Recommended"), rodomu ženkleliu sąrašo viduje. Trigger `role="combobox"` + `aria-expanded` + `aria-activedescendant`, popover `role="listbox"`, variantai `role="option"` + `aria-selected`; klaviatūra ArrowUp/Down, Home/End, Enter/Space, Esc, Tab uždaro; uždarymas paspaudus šalia. Jokių naujų dependencies — grynas React + CSS.
- Visoms naujoms className pridėti taisykles `dashboard.css` (`dashboard-css-coverage.test.ts` vartas), spalvas imti iš esamų design token'ų, veikti šviesioje ir tamsioje temoje; jokių inline `style` atributų. Naujus UI tekstus (jei jų reikia) dėti per `t(...)` ir `I18nContext.tsx` žodyną.
- Parašyti `SelectMenu.test.tsx`: atidarymas, pasirinkimas pele, pasirinkimas klaviatūra, Esc uždaro, aria atributai (`role`, `aria-expanded`, `aria-activedescendant`, `aria-selected`).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei reikėtų naujos dependency, silpninti testą/guard'ą arba liesti draudžiamus failus.

## Neįtraukta
`PolicyControlsPanel` prijungimas prie `SelectMenu`, „Available values" juostelių, `small` sakinių, `HelpPopover` ir `CODING_PRINCIPLES_HELP` šalinimas bei kortelių išdėstymo pertvarka — kita nuosekli užduotis. `PolicyProposalsPanel`, `HumanReviewPanel` ir `CompressionPage` migracija — neįtraukta. „Change reason" laukas lieka (public kontraktas).
