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
- `AG/openspec/changes/auto-032-shadow-matuoja-prompta-kuri-worker-realiai-gau/spec.md`

## Tikslas
Kompresijos panelės sakiniai UI turi įvardyti, KAS lyginama (prompt'o su kompresija vs be jos), ir naudoti verdikto šaltinio lauką, o ne seną formuluotę.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/panels/CompressionPanel.tsx`
- `ui-app/src/i18n/lt.ts`
- `ui-app/src/panels/CompressionPanel.test.tsx`

Draudžiama:
- `src/**`
- `AG/**`
- `vq/**`

## Veiksmas
- Panelėje rodyk verdikto šaltinio lauką ir sakinį, kuris įvardija lyginamą porą.
- Vertimus atnaujink kartu; jokių inline stilių — kiekviena nauja `className` privalo turėti taisyklę `dashboard.css`.
- Jei tikslūs failų vardai skiriasi, dirbk tuose pačiuose `ui-app/src` failuose, kurie jau renderina kompresijos verdiktą, ir nurodyk tai ataskaitoje.

## Patikra
- `pnpm --dir ui-app test`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sakinys reikalautų naujo lauko iš backend'o, kurio verdiktas negrąžina.

## Neįtraukta
- Telemetrijos laukai ir verdikto logika (ankstesni task'ai).
