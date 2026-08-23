# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Paleisti architecture contract patikrą šiam repo ir uždaryti boundary schema radinius.

## Agentai
readme-guard -> architect -> coder -> reviewer

## Failai
Leidžiama:
- `AG/orchestrator/src/core/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: 004

## Veiksmas
- Įgyvendinti: Paleisti architecture contract patikrą šiam repo ir uždaryti boundary schema radinius.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
