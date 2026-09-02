# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 106-apzvalga-uzbaigto-vykdymo-nebevadina-aktyviu

## Žingsnis 0 — ar jau įgyvendinta?
Jei `dashboard.css` jau turi `.brand .brand-title` taisyklę IR `.page-heading h1` /
`.usage-page-heading h1` selektorius šalia esamų `h2` — ALREADY_IMPLEMENTED: cituok
tas CSS eilutes kaip įrodymą.

## Tikslas
Paruošti CSS, kad puslapio antraščių semantiką (`h2` → `h1`) ir prekės ženklo
neutralizavimą būtų galima padaryti be vizualinio pokyčio. Šiuo metu stilius pririštas
prie elemento: `.brand h1` (245, 3831, 4516 eil.), `.page-heading h2` (3935-3936 eil.),
`.usage-page-heading h2` (2349 eil.). Šis darbas TIK išplečia selektorius — JSX
nekeičiamas, vizualiai niekas nesikeičia.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester.
readme-guard pirmas (keičiamas source).

## Failai
Leidžiama:
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/view/components/dashboard-css-coverage.test.ts` (tikėtina, kad keisti nereikės)
- `ui-app/src/i18n/I18nContext.tsx` (tikėtina, kad keisti nereikės; UI taisyklės reikalavimas)

Draudžiama:
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Prie kiekvienos `.brand h1` taisyklės (245, 3831, 4516 eil.) pridėk lygiavertį
  `.brand .brand-title` selektorių su identiškomis reikšmėmis.
- Prie `.page-heading h2` / `.usage-page-heading h2` (3935-3936, 2349 eil.) pridėk
  `h1` variantus tuose pačiuose selektorių sąrašuose; jei `h1` turi naršyklės default
  `font-size`/`margin`, jie perrašomi taip, kad išvaizda sutaptų su dabartiniu `h2`.
- Nieko netrink: `h2` selektoriai lieka, kol JSX dar jų reikia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Ataskaitoje pažymėk, ar `I18nContext.tsx` ir
`dashboard-css-coverage.test.ts` liko nepaliesti. Jei `pnpm test` krenta dėl CSS
dengiamumo varto — sustok ir paaiškink, netrink taisyklių.

## Neįtraukta
- JSX elementų keitimas (`Header.tsx`, puslapiai) — sekantys darbai.
- Panelių `panel-header h2` hierarchija.
- Pilnas WCAG antraščių auditas.
