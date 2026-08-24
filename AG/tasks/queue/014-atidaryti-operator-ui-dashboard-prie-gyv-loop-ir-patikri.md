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
- `ui-app/**`
- `src/interfaces/http/**`
- `src/composition/ui/**`
- `src/tests/composition-ui-*.test.ts`
- `AG/config/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: 007

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
