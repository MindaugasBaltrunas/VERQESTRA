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

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 out-of-scope failai legalizuoti — ciklo mygtukai realiai gyvena LoopControls/ConfirmButton, pirminis sąrašas buvo per siauras

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
`#/system` ciklo mygtukai neaiškina pasekmių. „Stabdyti" drain semantikos pastraipą perkelti prie paties mygtuko (subtekstas arba tooltip), o kiekvienas išjungtas mygtukas privalo turėti `title` su priežastimi, kodėl neaktyvus. Vienas šablonas visiems trims ciklo mygtukams.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/view/components/LoopControls.test.tsx`
- `ui-app/src/view/components/ConfirmButton.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: vienas bendras mygtuko šablonas su subtekstu ir `title` priežastimi; visi tekstai per `t(...)`.
- Coder: kiekviena nauja className turi taisyklę `dashboard.css`, abi temos.
- Tester: testai tvirtina `title` priežastį kiekvienam išjungtam mygtukui ir drain subtekstą prie „Stabdyti".

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei mygtuko išjungimo priežastis nepasiekiama be controller pakeitimo.

## Neįtraukta
Kiti System puslapio defektai.
