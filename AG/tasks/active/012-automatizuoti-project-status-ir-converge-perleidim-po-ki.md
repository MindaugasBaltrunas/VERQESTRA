# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su telemetry įrašu.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/application/release-readiness/**`
- `src/composition/quality/**`
- `src/tests/converge-readiness-backlog.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- Įgyvendinti: Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su telemetry įrašu.
- SVARBU (2026-08-25 istorija): ankstesnis bandymas parašė `commit-convergence.ts`
  (runCommitConvergence, commitConvergenceTelemetryPath) su testais, bet (1) testas nulūžo
  vidury darbo ir repair-parkavimo rollback'as visą necommit'intą implementaciją IŠPLOVĖ;
  (2) net žalioje būsenoje `runCommitConvergence` NETURĖJO produkcinio kvietėjo — mechanizmas
  be wiring'o nepraeina `dead-export-gate`. Šįkart use-case'as privalo būti PRIJUNGTAS prie
  commit kelio (composition sluoksnyje), ne tik eksportuotas; todėl į Leidžiama pridėtas
  `src/composition/quality/**`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
