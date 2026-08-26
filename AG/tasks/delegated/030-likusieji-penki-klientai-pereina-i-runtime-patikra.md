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
openspec/changes/verqestra-backlog-v1
docs/audits/ (UI auditas 2026-08-26, P1-2, antra dalis)

## Tikslas
Išplėsti runtime patikrą likusiems penkiems klientams, kad `as` per HTTP ribą nebeliktų nė
viename kelyje, ir uždėti vartą, neleidžiantį spragai grįžti.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/dashboardContract.ts`
- `ui-app/src/model/apiEnvelopes.test.ts`
- `ui-app/src/model/types.ts`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: 029-http-riba-tikrinama-runtime-ne-as-zyma

## Veiksmas
- Naudoti patikros primityvą, įtvirtintą task'e 029 — naujo NEKURTI. Jei jo nėra, task'as
  laukia 029, o ne improvizuoja antrą mechanizmą.
- Pritaikyti jį penkiems likusiems keliams `ui-app/src/model/api.ts`:
  `fetchWorkflowTasks` (`:107`), `uploadTaskFiles` (`:155`), `setRequestedWorkers` (`:185`),
  `fetchTokenUsage` (`:257`), `fetchTokenAnalytics` (`:263`).
- `fetchTokenUsage` ir `fetchTokenAnalytics` yra didžiausi atsakymai — tikrinti tik tuos
  laukus, kuriuos UI realiai skaito. Pilna gilaus objekto patikra čia būtų brangesnė už
  naudą ir pasentų su kiekvienu serverio priedu.
- Uždėti VARTĄ: testas, kuris `api.ts` tekste ieško `response.json() as` / `r.json() as`
  formos ir krenta radęs. Be jo taisyklė vėl nutrūks ties trečiu klientu, kaip nutrūko po
  2026-08-23 audito.
- Vartas privalo kristi ant dabartinės būsenos prieš taisymą — tai jo teisingumo įrodymas.
- Testai kiekvienam keliui: teisingas atsakymas praeina; sugadintas meta klaidą su
  maršruto vardu.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios IR vartas praeina. Sustok, jei kuris nors atsakymas
pasirodytų neturintis stabilios formos — tokį atvejį įvardyk ataskaitoje, nespręsk tyliai.

## Neįtraukta
- Serverio atsakymų formos keitimas.
- SSE srauto patikra.
- Naujų bibliotekų įvedimas.
