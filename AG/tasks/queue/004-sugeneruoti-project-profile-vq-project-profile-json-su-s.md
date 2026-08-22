# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Sugeneruoti project profile: vq/project/profile.json su source roots ir default config.

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
- Įgyvendinti: Sugeneruoti project profile: vq/project/profile.json su source roots ir default config.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
