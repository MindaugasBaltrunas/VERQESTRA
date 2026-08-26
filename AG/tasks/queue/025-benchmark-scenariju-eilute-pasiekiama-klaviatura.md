# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (UI auditas 2026-08-26, P1-1)

## Tikslas
Padaryti benchmark scenarijų lentelės eilutę pasiekiamą klaviatūra ir ekrano skaitytuvui.
Šiuo metu scenarijaus detalių panelė atsidaro TIK pele — WCAG 2.1.1 (Keyboard) pažeidimas
vieninteliame tokiame UI taške.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/BenchmarkPage.tsx`
- `ui-app/src/view/pages/BenchmarkPage.test.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `ui-app/src/view/pages/BenchmarkPage.tsx:274` renderina
  `<tr className="benchmark-scenario-row…" onClick={() => setSelectedScenarioKey(key)}>`
  be `tabIndex`, be `onKeyDown` ir be `role`. Patikrinta visame `ui-app/src` — tai
  VIENINTELIS paspaudžiamas ne-mygtukas, tad taisymas yra taškinis, ne kampanija.
- Pasirinkti VIENĄ sprendimą ir jo laikytis: arba eilutė gauna `tabIndex={0}`,
  `role="button"`, `aria-pressed` ir `onKeyDown` (Enter + Space), arba pirmoje ląstelėje
  atsiranda tikras `<button>`, o `<tr>` nustoja būti interaktyvi. Antras variantas
  pageidautinas — jis nereikalauja imituoti mygtuko semantikos.
- Fokusas privalo būti MATOMAS: jei pasirinktas variantas su `tabIndex`, `dashboard.css`
  reikia `:focus-visible` kontūro `benchmark-scenario-row` klasei; be jo klaviatūros
  vartotojas nemato, kur yra.
- Pasirinkta eilutė privalo būti skelbiama programiškai (`aria-pressed` arba
  `aria-current`), ne vien CSS klase `selected`.
- Testas `BenchmarkPage.test.tsx`: Enter ir Space klavišai atidaro scenarijaus detales;
  eilutė pasiekiama per `Tab`; pasirinkimas matomas per prieinamą atributą, ne per klasę.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sprendimas reikalautų keisti scenarijų
duomenų srautą ar `BenchmarkReportView` kontraktą — šio task'o apimtis yra tik sąveika.

## Neįtraukta
- Kitų lentelių ar panelių prieinamumo peržiūra.
- Bendras a11y auditas (atskiras darbas).
- Backend pakeitimai.
