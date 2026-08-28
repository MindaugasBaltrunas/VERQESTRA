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
`AG/openspec/changes/verqestra-backlog-v1/`

## Tikslas
`#/system` maršrute virš SystemStatusHero lieka žmogiška santrauka; vidiniai mechanizmai (lease'ų lentelė, bangų įvykiai, hash'ai, diagnostika) — RuntimePanel, TokenBudgetPanel, WavesPanel, DiagnosticsPanel turinys po hero — sudedami į išskleidžiamus `<details>/<summary>` blokus su i18n antraštėmis. Nė vienas duomuo neišmetamas, tik perkeliamas žemiau ir slepiamas pagal nutylėjimą.

## Agentai
Privaloma grandinė: `readme-guard -> architect -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/WavesPanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: fiksuoja galutinę `#/system` tvarką — SystemStatusHero viršuje neuždengtas, po jo `<details>` blokai (Runtime/Budget/Waves/Diagnostics turiniui); patvirtina, kad nė vienas esamas blokas nedingsta iš DOM.
- Coder: DashboardPage.tsx apgaubia po-hero panelių sekciją `<details>/<summary>` elementais su `t(...)` antraštėmis (seka esamu `.failure-details`/`.recommendation-card` CSS raštu dashboard.css); WavesPanel.tsx lease/wave turinį sugrupuoja analogiškai; kiekviena nauja className turi taisyklę dashboard.css abiem temoms.
- Tester: WavesPanel.test.tsx patvirtina, kad detalių turinys išlieka DOM'e ir yra pasiekiamas po `summary` antrašte (net kai `<details>` uždarytas pagal nutylėjimą).

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei perkėlimas pareikalautų keisti `ui-app/src/controller/**` arba `src/**`.

## Neįtraukta
Naujų duomenų šaltinių kūrimas serveryje; RuntimePanel.tsx, TokenBudgetPanel.tsx, DiagnosticsPanel.tsx vidinių failų keitimas (jie tik apgaubiami DashboardPage.tsx lygyje).
