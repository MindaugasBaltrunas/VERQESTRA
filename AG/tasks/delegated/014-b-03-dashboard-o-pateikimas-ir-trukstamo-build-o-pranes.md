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
`openspec/changes/verqestra-backlog-v1/` — eilutė „Atidaryti operator ui dashboard prieš gyvą loop'ą ir patikrinti SSE srautą“ (dashboard'o pateikimo dalis).

## Tikslas
Įrodyti testu, kad UI serveris, pakeltas TIKRU `listenUiServer` keliu ant efemerinio loopback porto, į šaknies GET grąžina arba `text/html` su įrašytu UI token'u, arba atsakymą su `UI_BUILD_COMMAND`, o ne tuščią 404.

## Agentai
Privaloma grandinė: `readme-guard -> tester -> reviewer`. readme-guard pirmas; be jo ribų santraukos nedirbti.

## Failai
Leidžiama:
- `src/tests/composition-ui-dashboard-serve.test.ts`

Draudžiama:
- `src/composition/ui/server.ts`
- `src/composition/ui/command.ts`
- `src/interfaces/http/ui-security.ts`
- `src/tests/composition-ui-server.test.ts`
- `ui-app/**`
- `dist/**`
- `node_modules/**`
- `.env`
- `.env.*`

## Veiksmas
- Sukurti `src/tests/composition-ui-dashboard-serve.test.ts`: per `createUiServer` + `listenUiServer(server, 0)` pakelti serverį ir per `fetch` paimti šaknies kelią; serverį uždaryti deterministiškai (`finally`).
- Patvirtinti abu atvejus su laikinu `staticDir`: su `index.html` — 200 `text/html` ir `<meta name="vq-ui-token">` reikšmė; be `index.html` — atsakymo tekste yra `UI_BUILD_COMMAND` (importuoti konstantą, netipinti eilutės ranka).
- Patvirtinti, kad `listenUiServer` grąžintas adresas yra loopback (`127.0.0.1`), ne `0.0.0.0`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit tik kai abi patikros žalios. Sustoti ir pranešti, jei: (a) paaiškėja, kad `src/tests/composition-ui-server.test.ts` jau dengia būtent šį realų listen kelią 1:1 — tada dublikato NEkurti, o parašyti, kas konkrečiai jau padengta; (b) testui praeiti reikėtų keisti produkto kodą arba kurti/keisti `ui-app` failus.

## Neįtraukta
- SSE srauto tikrinimas (atskiras darbas — jau yra `src/tests/composition-ui-sse-live-updates.test.ts`).
- `ui-app` kodo ar build'o keitimas, produkto kodo taisymas.
- LLM kvietimai, gyvo queue loop'o vykdymas, naršyklė, MCP, vector DB.
