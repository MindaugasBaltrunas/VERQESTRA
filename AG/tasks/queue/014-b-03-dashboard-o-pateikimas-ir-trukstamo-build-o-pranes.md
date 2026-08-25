# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
AG/openspec/changes/verqestra-backlog-v1/tasks.md — eilute „Atidaryti operator ui dashboard pries gyva loop'a ir patikrinti SSE srauta"

## Tikslas
Irodyti testu, kad operatorius, atidares dashboard'o saknini kelia, gauna arba tikra `ui-app` build'a, arba aiskia instrukcija `pnpm build:ui`, o ne tuscia 404.

## Agentai
Privaloma grandine: `readme-guard -> tester -> reviewer`. readme-guard pirmas, be jo ribu santraukos nedirbti.

## Failai
Leidziama:
- `src/tests/composition-ui-dashboard-serve.test.ts`

Draudziama:
- `src/composition/ui/server.ts`
- `src/interfaces/http/ui-security.ts`
- `ui-app/**`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurti `src/tests/composition-ui-dashboard-serve.test.ts`: pakelti tikra UI serveri ant efemerinio loopback porto ir per HTTP paimti saknini dashboard'o kelia.
- Patvirtinti abu atvejus: esant `ui-app` build'ui grazinamas `text/html` su iterptu UI token'u; nesant build'ui atsakymas mini `pnpm build:ui` (konstanta `UI_BUILD_COMMAND`), o ne tuscia 404.
- Patvirtinti, kad serveris klauso tik loopback'e; uzdaryti serveri deterministiskai.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit tik kai abi patikros zalios. Sustoti ir pranesti, jei tikram build'ui reiketu kurti ar keisti `ui-app` failus — tai uz sio scope ribu.

## Neitraukta
- `ui-app` kodo ar build'o keitimas.
- Produkto kodo taisymas.
- LLM kvietimai, gyvo queue loop'o vykdymas, narsykle, scraper, MCP, vector DB.
