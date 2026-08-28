# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
„User Claude terminal" blokas `#/system` puslapyje atrodo kaip sugedęs pultas — monitorius be valdiklių. Kai sesijos nėra, blokas arba slepiamas už išskleidimo, arba aiškiai pasako: „stebėjimo blokas: rodys tavo paleistą Claude sesiją; dabar jos nėra". Jokių elementų, kurie atrodo spaudžiami, bet nieko nedaro.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: rasti terminalo bloką ir be sesijos rodyti paaiškinamąją tuščią būseną per `t(...)`; pseudo-interaktyvius elementus pašalinti arba paversti nespaudžiamais.
- Coder: kiekviena nauja className turi taisyklę `dashboard.css`, abi temos.
- Tester: testas dengia būseną be sesijos ir su sesija.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei blokas gyvena už leidžiamų failų ribų.

## Neįtraukta
Vidinių detalių kėlimas į `details` blokus — paskutinė užduotis.
