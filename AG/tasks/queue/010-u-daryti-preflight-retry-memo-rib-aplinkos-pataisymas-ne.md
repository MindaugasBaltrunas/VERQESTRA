# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Uždaryti preflight retry memo ribą: aplinkos pataisymas neturi atrodyti kaip human review kilpa.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/application/quality-gates/**`
- `src/tests/quality-gates-*.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- Įgyvendinti: Uždaryti preflight retry memo ribą: aplinkos pataisymas neturi atrodyti kaip human review kilpa.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
