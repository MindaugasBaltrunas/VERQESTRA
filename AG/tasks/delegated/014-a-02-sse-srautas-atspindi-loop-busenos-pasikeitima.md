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
AG/openspec/changes/verqestra-backlog-v1/tasks.md — eilutė „Atidaryti operator ui dashboard prieš gyvą loop'ą ir patikrinti SSE srautą"

## Tikslas
Irodyti testu, kad pasikeitus loop busenai (runtimeRoot/state/claude-resume.json) atidarytas /api/events srautas atiduoda antra freima su pasikeitusia reiksme, sudetu is TIKRO wiring'o (createUiServer + createSseHub + ssePorts), ne fake hub'o.

## Agentai
Privaloma grandine: readme-guard -> tester -> reviewer. readme-guard pirmas, be jo ribu santraukos nedirbti.

## Failai
Leidziama:
- `src/tests/composition-ui-sse-live-updates.test.ts`

Draudziama:
- `src/composition/ui/server.ts`
- `src/composition/ui/sse-adapters.ts`
- `src/composition/ui/command.ts`
- `src/interfaces/http/sse-service.ts`
- `ui-app/**`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujame teste sukurti laikina runtimeRoot direktorija (mkdtemp), sudeti realu wiring pagal src/composition/ui/command.ts pavyzdi: `ssePorts` (src/composition/ui/sse-adapters.ts) + `createSseHub` (src/interfaces/http/sse-service.ts) + `createUiServer`/`listenUiServer` (src/composition/ui/server.ts, sablonas serverio pakelimui — src/tests/composition-ui-server.test.ts), pakelti ant efemerinio 127.0.0.1 porto ir atidaryti GET /api/events HTTP jungti.
- Prieš atidarant jungti, irasyti `runtimeRoot/state/claude-resume.json` su viena busena (pvz. status "started"); po pirmo gauto SSE freimo perrasyti ta pati faila su kitokia busena (pvz. status "running") ir palaukti KITO freimo — laukimas remiasi gautu duomenu skirtumu (arba event emitteriu), ne fiksuotu setTimeout.
- Patvirtinti assert'u, kad antras freimas skiriasi nuo pirmo ir atspindi nauja busena; uzdaryti jungti ir serveri deterministiskai (finally/listening.close()).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit tik kai abi patikros zalios. Sustoti ir pranesti, jei paaiskeja, kad busenos pasikeitimas i srauta nepatenka (pvz. per lenktas SSE_POLL_INTERVAL_MS ar mtime granuliariskuma testas negali determinuotai pagauti antro freimo) — tai produkto defektas arba testo dizaino riba, atskira uzduotis, ne sio scope taisymas.

## Neitraukta
- ui-app build'o pateikimo kelias (kita uzduotis).
- Produkto kodo taisymas.
- LLM kvietimai, gyvo queue loop'o vykdymas, narsykle, scraper, MCP, vector DB.
