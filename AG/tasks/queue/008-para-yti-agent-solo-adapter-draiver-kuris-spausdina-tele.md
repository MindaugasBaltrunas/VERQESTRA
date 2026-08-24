# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Parašyti agent-solo adapter draiverį, kuris spausdina telemetrijos voką benchmark celėse.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `AG/benchmark/**`
- `src/infrastructure/adapters/**`
- `src/tests/benchmark-*.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- Įgyvendinti: Parašyti agent-solo adapter draiverį, kuris spausdina telemetrijos voką benchmark celėse.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
