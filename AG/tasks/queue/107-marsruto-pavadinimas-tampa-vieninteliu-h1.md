# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 106-apzvalga-uzbaigto-vykdymo-nebevadina-aktyviu

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/Header.tsx` prekės ženklas „VERQESTRA"
(dabar 58 eil. `<h1>`) nebėra `h1`, o maršruto pavadinimas
(`DashboardPage.tsx` page-heading, dabar 153 eil. `<h2>`) yra `h1` —
ALREADY_IMPLEMENTED: cituok abiejų vietų JSX kaip įrodymą.

## Tikslas
UI audito P2 (docs/audits/ui-app-2026-08-31/report.md, „Puslapio pavadinimas
nėra pagrindinis H1"): vienintelis `h1` visuose ekranuose yra prekės ženklas
„VERQESTRA", o aktyvaus puslapio pavadinimas („Užduotys", „Sistema") — `h2`;
ekrano skaitytuvo antraščių navigacijoje tai silpnina orientaciją. Patikrinta
2026-09-01: `Header.tsx:58` — `<h1>VERQESTRA</h1>`; maršruto pavadinimai
renderinami `page-heading` blokuose PENKIOSE vietose: `DashboardPage.tsx:153`
(`pageMeta(activeRoute).title`, dengia pagrindinius maršrutus),
`BenchmarkPage.tsx:131-134`, `CompressionPage.tsx:154-157`,
`ReliabilityPage.tsx:142-143` ir `TokenUsagePage.tsx:61-64/138-141`
(`usage-page-heading`) — visur `h2`. Sprendimas pagal report: prekės ženklą
pateikti kaip neutralų elementą (ar nuorodą į apžvalgą), o KIEKVIENO maršruto
pavadinimą padaryti vieninteliu `h1`. CSS pusėje `.page-heading h2` /
`.usage-page-heading h2` selektoriai (dashboard.css:2349, 3916-3917) turi
sekti elemento pakeitimą — vizualinė hierarchija lieka ta pati, keičiasi tik
semantika.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/pages/BenchmarkPage.tsx`
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/view/pages/ReliabilityPage.tsx`
- `ui-app/src/view/pages/TokenUsagePage.tsx`
- `ui-app/src/view/styles/dashboard.css` (h1/h2 selektorių atnaujinimas)
- `ui-app/src/i18n/I18nContext.tsx` (tikėtina, kad keisti NEREIKĖS — keičiasi
  tik elementų semantika; įtrauktas etalono UI taisyklei, jei prekės ženklo
  neutralizavimui prireiktų naujo teksto, pvz. aria-label)
- `ui-app/src/view/accessibility.test.tsx`
- `ui-app/src/view/pages/BenchmarkPage.test.tsx`
- `ui-app/src/view/pages/CompressionPage.test.tsx`
- `ui-app/src/view/pages/ReliabilityPage.test.tsx`
- `ui-app/src/view/pages/TokenUsagePage.test.tsx`

Draudžiama:
- Panelių `h2` antraštės komponentuose (panel-header lygis lieka h2 —
  keičiami tik puslapio lygio pavadinimai)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `Header.tsx` (58 eil.): „VERQESTRA" iš `h1` į neutralų elementą su ta pačia
  vizualine išvaizda (nauja/perkelta CSS taisyklė, jei reikia).
- Penkiuose page-heading blokuose maršruto pavadinimo elementas iš `h2` į
  `h1`; `dashboard.css` atitinkami selektoriai atnaujinami taip, kad
  vizualinė išvaizda nepasikeistų.
- Suderinti, kad vienu metu DOM'e būtų LYGIAI vienas `h1`
  (`TokenUsagePage.tsx` turi du sąlyginius `usage-page-heading` blokus 61 ir
  138 eil. — jie renderinami alternatyviai, patikrinti, kad taip ir liktų).
- Testų lūkestis: `accessibility.test.tsx` — kiekvienam maršrutui DOM turi
  lygiai vieną `h1` ir jis yra maršruto pavadinimas, ne „VERQESTRA"; esami
  puslapių testai, jei assert'ina heading lygius, atnaujinami (silpninti
  draudžiama — keičiasi tik lygio skaičius).

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Jei prekės ženklo pavertimas nuoroda
pareikalauja naujo i18n teksto (aria-label ir pan.) — `I18nContext.tsx` yra
Leidžiama sąraše, naujas raktas pridedamas su LT vertimu ir įrašomas į
ataskaitą; jei I18nContext liko nepaliestas, tai irgi pažymima ataskaitoje.

## Neįtraukta
- Panelių antraščių (`panel-header h2`) hierarchijos auditas — report'as
  kėlė tik puslapio lygio klausimą.
- Pilnas WCAG antraščių auditas — report'o ribose jo nebuvo.
- `page-eyebrow`/aprašymo tekstų keitimai — tik elemento semantika.
