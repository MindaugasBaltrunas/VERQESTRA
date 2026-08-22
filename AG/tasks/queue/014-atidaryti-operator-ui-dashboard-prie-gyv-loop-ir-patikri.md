# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Atidaryti operator ui dashboard prieš gyvą loop'ą ir patikrinti SSE srautą.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/src/commands/**`
- `src/src/orchestrator/**`
- `src/apps/**`
- `src/packages/**`
- `src/modules/**`
- `src/workers/**`
- `AG/config/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Įgyvendinti: Atidaryti operator ui dashboard prieš gyvą loop'ą ir patikrinti SSE srautą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.

## Neįtraukta
- LLM kvietimai.
- Queue loop vykdymas.
- Naršyklės, scraper, MCP ar vector DB integracijos.
