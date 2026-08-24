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
- `src/application/project-bootstrap/**`
- `src/infrastructure/bootstrap/**`
- `src/tests/bootstrap-*.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

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
