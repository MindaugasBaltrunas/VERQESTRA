# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
docs/audits/021-rollback-preserve-design-2026-08-25.md

## Tikslas
Pašalinti 24 s lenktynę tarp Claude proceso pabaigos ir Stop hook'o commit'o: prieš verify coordinator laukia SAVO stop-bridge įrodymo ribotą langą, naudodamas esamą `waitForOwnStopBridgeDone`.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/application/task-execution/stop-bridge-wait.ts`
- `src/infrastructure/state/stop-bridge/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Prieš verify iškvietimą suriš esamą `waitForOwnStopBridgeDone` su jau egzistuojančiu probe; langas imamas iš `stopBridgeWaitMs` (env + kieta luba), be naujų konstantų.
- `own-done` nutraukia laukimą iškart; timeout nekeičia verdikto — tik nebeleidžia verify bėgti anksčiau už hook'ą.
- Testu patikrink abi šakas: vėluojantis savas „done" sulaukiamas, o timeout grąžina tą patį elgesį kaip dabar.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų keisti `stop-bridge` kontraktą arba `stop-bridge-wait` grynas taisykles.

## Neįtraukta
- Rollback išsaugojimas ir verify priežastis — jau atlikti ankstesniuose darbuose.
