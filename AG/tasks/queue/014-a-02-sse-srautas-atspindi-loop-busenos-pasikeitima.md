# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
AG/openspec/changes/verqestra-backlog-v1/tasks.md — eilute „Atidaryti operator ui dashboard pries gyva loop'a ir patikrinti SSE srauta"

## Tikslas
Irodyti testu, kad pasikeitus loop busenai atidarytas `/api/events` srautas atiduoda atnaujinta snapshot'a — dashboard'as gyvo loop'o metu nelieka uzsaldytas.

## Agentai
Privaloma grandine: `readme-guard -> tester -> reviewer`. readme-guard pirmas, be jo ribu santraukos nedirbti.

## Failai
Leidziama:
- `src/tests/composition-ui-sse-live-updates.test.ts`

Draudziama:
- `src/composition/ui/server.ts`
- `src/interfaces/http/sse-service.ts`
- `ui-app/**`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurti `src/tests/composition-ui-sse-live-updates.test.ts`: pakelti tikra UI serveri ant efemerinio loopback porto ir atidaryti `/api/events` HTTP jungti (sablonas — `src/tests/composition-ui-sse-live.test.ts`).
- Pakeisti loop busena per ta pati wiring'a, kuri naudoja serveris, ir patvirtinti, kad srautas atiduoda antra freima su pasikeitusia reiksme, o ne pakartoja pirmaji.
- Uzdaryti jungti ir serveri deterministiskai; laukimas remiasi gautu freimu, ne fiksuotu `setTimeout`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit tik kai abi patikros zalios. Sustoti ir pranesti, jei paaiskeja, kad busenos pasikeitimas i srauta nepatenka — tai produkto defektas ir atskira uzduotis, ne sio scope taisymas.

## Neitraukta
- `ui-app` build'o pateikimo kelias (kita uzduotis).
- Produkto kodo taisymas.
- LLM kvietimai, gyvo queue loop'o vykdymas, narsykle, scraper, MCP, vector DB.
