# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Priklausomybės
- 060-uzbaigimo-sargas-priima-already-implemented-be-rasymu
- 061-w2-vaiko-stderr-log-orchestrator-log
- 062-a-02-kompozicija-perduoda-visa-vq-config-kataloga
- 062-b-03-testas-dengia-rekursyvia-config-katalogo-kopija

## Tikslas
`#/system` puslapyje amžinai „laksto linija" — indeterminate progress animacija (tikėtina slot progress / ETA juosta), kuri be realių duomenų sukasi be pabaigos. Pakeisti sąžininga būsena: realus progresas, kai duomenys yra; statinė tekstinė būsena, kai jų nėra. Jokių amžinų animacijų.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/SlotProgressCard.tsx`
- `ui-app/src/view/components/SlotProgressCard.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: surasti indeterminate animaciją (`@keyframes` / `animation` taisyklė `dashboard.css` ir jos className) ir pašalinti kartu su nebenaudojama taisykle.
- Coder: be duomenų rodyti statinį tekstą per `t(...)`; su duomenimis — realų užpildymą.
- Tester: testas tvirtina, kad be duomenų animacinė klasė nerenderinama.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei animacija gyvena už leidžiamų failų ribų.

## Neįtraukta
Kiti System puslapio defektai.
