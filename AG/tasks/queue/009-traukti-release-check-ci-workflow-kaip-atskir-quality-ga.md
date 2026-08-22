# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Įtraukti release-check į ci workflow kaip atskirą quality gate žingsnį.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/.github/workflows/**`
- `src/docs/release/**`
- `src/templates/VERSION/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Įgyvendinti: Įtraukti release-check į ci workflow kaip atskirą quality gate žingsnį.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
