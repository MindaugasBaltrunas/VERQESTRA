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

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
