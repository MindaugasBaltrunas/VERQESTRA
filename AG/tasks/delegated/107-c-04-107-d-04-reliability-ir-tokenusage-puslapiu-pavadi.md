## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 107-b-03-107-c-03-benchmark-ir-compression-puslapiu-pavadin

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ReliabilityPage.tsx` (dabar 142-143 eil.) ir abu `TokenUsagePage.tsx`
`usage-page-heading` blokai (dabar 61-64 ir 138-141 eil.) jau naudoja `<h1>` —
ALREADY_IMPLEMENTED: cituok visus tris JSX blokus.

## Tikslas
Paskutinis UI audito P2 žingsnis: šie du maršrutai lieka be `h1`, kol jų page-heading
pavadinimai yra `h2`. Po šio darbo KIEKVIENAS maršrutas turi lygiai vieną `h1` —
maršruto pavadinimą. CSS `.page-heading h1` / `.usage-page-heading h1` jau paruošti.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/pages/ReliabilityPage.tsx`
- `ui-app/src/view/pages/ReliabilityPage.test.tsx`
- `ui-app/src/view/pages/TokenUsagePage.tsx`
- `ui-app/src/view/pages/TokenUsagePage.test.tsx`
- `ui-app/src/view/styles/dashboard.css` (jau paruoštas anksčiau; tikėtina, kad naujų taisyklių čia nereikės)
- `ui-app/src/i18n/I18nContext.tsx` (tikėtina, kad keisti nereikės: keičiasi tik elemento semantika)

Draudžiama:
- `ui-app/src/view/accessibility.test.tsx` (priklauso 107-a-02)
- `ui-app/src/view/components/Header.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ReliabilityPage.tsx` page-heading pavadinimo elementą iš `h2` į `h1`.
- `TokenUsagePage.tsx` abiejuose `usage-page-heading` blokuose (61 ir 138 eil.) `h2` → `h1`;
  patikrink, kad blokai lieka alternatyvūs (niekada nerenderinami abu vienu metu).
- Jei puslapių testai assert'ina heading lygį — atnaujink lygį, neužsilpnink asserto.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Ataskaitoje patvirtink, kad `TokenUsagePage`
negali atiduoti dviejų `h1` vienu metu. Jei gali — sustok ir pranešk.

## Neįtraukta
- Panelių `panel-header h2` hierarchijos auditas.
- Pilnas WCAG antraščių auditas.
- `page-eyebrow` / aprašymo tekstų keitimai.
