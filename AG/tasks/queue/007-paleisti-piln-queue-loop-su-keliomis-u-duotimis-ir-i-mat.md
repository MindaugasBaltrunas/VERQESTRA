# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Paleisti pilną queue loop su keliomis užduotimis ir išmatuoti dispatch flow.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/**`

> BROAD SCOPE: generated allowed paths include src/**; review before execution.

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Įgyvendinti: Paleisti pilną queue loop su keliomis užduotimis ir išmatuoti dispatch flow.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
