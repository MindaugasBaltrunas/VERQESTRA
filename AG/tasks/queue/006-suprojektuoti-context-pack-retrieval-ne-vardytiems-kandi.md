# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Suprojektuoti context pack retrieval neįvardytiems kandidatams po rag-lite pakopų trynimo.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/application/context-pack/**`
- `src/application/code-intelligence/retrieval/**`
- `src/tests/context-pack-*.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- Įgyvendinti: Suprojektuoti context pack retrieval neįvardytiems kandidatams po rag-lite pakopų trynimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
