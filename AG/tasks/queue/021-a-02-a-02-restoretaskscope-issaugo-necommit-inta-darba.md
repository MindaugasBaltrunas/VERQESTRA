# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
docs/audits/021-rollback-preserve-design-2026-08-25.md

## Tikslas
Įgyvendinti kontrakto dalį, kad task-scoped rollback'as prieš atstatydamas kelius IŠSAUGOTŲ jų necommit'intą turinį (snapshot ref arba stash su task žyma) ir grąžintų, kur darbas guli.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/rollback-scope.ts`
- `src/tests/infrastructure-git.test.ts`

Draudžiama:
- `src/infrastructure/state/stop-bridge/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Prieš `restoreTaskScope` kilpą sukurk task'o kelių snapshot'ą (pvz. `git stash create` / `commit-tree`) ir grąžink jo ref'ą `TaskScopeRestoreResult` lauke; jokio naujo eksporto be kvietėjo.
- Snapshot'o nesėkmė yra fail-closed: rollback'as neatstato ir grąžina `ok:false` su priežastimi, o ne tyliai tęsia.
- Padenk testu prieš tikrą temp repo: 2 necommit'inti keliai → po rollback'o medis atstatytas, o snapshot ref turi ankstesnį turinį.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok, jei prireiktų keisti `stop-bridge` kontraktą arba domain `rollback-rules` taisykles.

## Neįtraukta
- `rollback-stable` išvestis, `verify-task` priežastis, coordinator laukimas — atskiri darbai.
