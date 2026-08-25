## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
AG/openspec/changes/verqestra-backlog-v1/tasks.md — eilute „Atidaryti operator ui dashboard pries gyva loop'a ir patikrinti SSE srauta"

## Tikslas
Irodyti testu, kad operator UI dashboard'as pakyla ir SSE srautas `/api/events` yra gyvas per tikra HTTP jungti, pries paleidziant gyva loop'a.

## Agentai
Privaloma grandine: `readme-guard -> tester -> reviewer`. readme-guard pirmas, be jo ribu santraukos nedirbti.

## Failai
Leidziama:
- `src/tests/composition-ui-sse-live.test.ts`

Draudziama:
- `src/composition/ui/server.ts`
- `src/interfaces/http/sse-service.ts`
- `ui-app/**`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurti `src/tests/composition-ui-sse-live.test.ts`: pakelti tikra UI serveri per esama `src/composition/ui/server.ts` eksporta ant efemerinio loopback porto (port 0), naudojant esamu testu (`src/tests/composition-ui-server.test.ts`) wiring'o sablona.
- Tikru HTTP request'u atidaryti `/api/events` ir patvirtinti: statusas 200, `content-type: text/event-stream`, gaunamas bent vienas pilnas SSE freimas (`data:` eilute + tuscia eilute), ir serveris srauto pats neuzdaro.
- Testo pabaigoje uzdaryti SSE jungti ir serveri taip, kad `node --test` procesas neliktu kabeti; jokiu `setTimeout` be deterministinio sinchronizavimo su serverio ivykiu.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit tik kai abi patikros zalios. Sustoti ir pranesti (be produkto kodo taisymo), jei testas atidengia realu serverio ar SSE defekta — tai atskira uzduotis, ne sio scope dalis. Taip pat sustoti, jei patikrai reiketu keisti bet kuri `Draudziama` faila.

## Neitraukta
- SSE snapshot'o atnaujinimas pasikeitus loop busenai (kita uzduotis).
- `ui-app` build'o pateikimo kelias ir jo trukumo pranesimas (kita uzduotis).
- LLM kvietimai, gyvo queue loop'o vykdymas, narsykle, scraper, MCP, vector DB.
