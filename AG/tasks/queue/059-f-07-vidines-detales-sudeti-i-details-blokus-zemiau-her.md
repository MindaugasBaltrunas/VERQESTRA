# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
`#/system` viršuje turi likti žmogiška santrauka, o vidiniai mechanizmai — lease'ai, bangų įvykiai, hash'ai ir diagnostika — nukeliami žemiau hero į išskleidžiamus `details` blokus. Nieko nešalinti: ekspertui pasiekiama, žmogui netrukdo.

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
- Architect: galutinė puslapio tvarka — hero viršuje, po jo įvardyti `details` blokai; patvirtina, kad nė vienas blokas nedingsta.
- Coder: perkelti blokus į `details`/`summary` su `t(...)` antraštėmis; kiekviena nauja className turi taisyklę `dashboard.css`, abi temos.
- Tester: testai tvirtina, kad detalių turinys išlieka DOM'e ir yra po `summary` antrašte.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei perkėlimas pareikalautų keisti controller sluoksnį.

## Neįtraukta
Naujų duomenų šaltinių kūrimas serveryje.
