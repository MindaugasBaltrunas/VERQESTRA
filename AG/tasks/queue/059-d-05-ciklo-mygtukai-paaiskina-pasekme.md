# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Priklausomybės
- 060-uzbaigimo-sargas-priima-already-implemented-be-rasymu
- 061-w2-vaiko-stderr-log-orchestrator-log
- 062-a-02-kompozicija-perduoda-visa-vq-config-kataloga
- 062-b-03-testas-dengia-rekursyvia-config-katalogo-kopija

## Tikslas
`#/system` ciklo mygtukai neaiškina pasekmių. „Stabdyti" drain semantikos pastraipą perkelti prie paties mygtuko (subtekstas arba tooltip), o kiekvienas išjungtas mygtukas privalo turėti `title` su priežastimi, kodėl neaktyvus. Vienas šablonas visiems trims ciklo mygtukams.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
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
