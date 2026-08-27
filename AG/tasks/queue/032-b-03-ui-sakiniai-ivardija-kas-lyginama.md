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
