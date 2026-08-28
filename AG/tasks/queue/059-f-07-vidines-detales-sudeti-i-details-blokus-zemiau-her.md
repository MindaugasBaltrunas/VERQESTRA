# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Priklausomybės
- 060-uzbaigimo-sargas-priima-already-implemented-be-rasymu
- 061-w2-vaiko-stderr-log-orchestrator-log
- 062-a-02-kompozicija-perduoda-visa-vq-config-kataloga
- 062-b-03-testas-dengia-rekursyvia-config-katalogo-kopija
- 064-a-02-orphan-reaper-kviecia-registraciju-valyma-po-katal
- 064-b-03-provisioning-pries-git-worktree-add-isvalo-to-pati

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
