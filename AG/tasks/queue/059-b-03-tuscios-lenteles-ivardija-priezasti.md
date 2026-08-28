# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Priklausomybės
- 060-uzbaigimo-sargas-priima-already-implemented-be-rasymu
- 061-w2-vaiko-stderr-log-orchestrator-log
- 062-a-02-kompozicija-perduoda-visa-vq-config-kataloga
- 062-b-03-testas-dengia-rekursyvia-config-katalogo-kopija

## Tikslas
Tuščios `#/system` lentelės meluoja tylėdamos. Workerių lease lentelė: vietoj „Aktyvių lease'ų nėra" rodyti „Worktree politika išjungta (vq/config/worktree-policy.json) — lease'ų nebus ir antras srautas nepakils" (naudoti waves view worktree politikos lauką). „Bangų detalės": vietoj „nėra duomenų" — kada jų atsiras.

## Agentai
Privaloma grandinė: `readme-guard -> architect -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/WavesPanel.test.tsx`
- `ui-app/src/model/types.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: `types.ts` papildyti worktree politikos lauku pagal serverio kontraktą; `WavesPanel.tsx` tuščias būsenas keisti priežastimis per `t(...)`.
- Coder: kiekviena nauja className turi taisyklę `dashboard.css`, abi temos.
- Tester: testai dengia tuščią lentelę su išjungta politika, su įjungta politika ir su duomenimis.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei serverio laukas dar nepridėtas arba jo vardas neatitinka.

## Neįtraukta
Serverio laukas — atskira ankstesnė užduotis. Animacija, mygtukai, `details` blokai — vėlesnės.
