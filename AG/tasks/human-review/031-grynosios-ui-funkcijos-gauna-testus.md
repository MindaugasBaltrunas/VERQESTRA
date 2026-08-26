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
docs/audits/ (UI auditas 2026-08-26, P3)

## Tikslas
Padengti testais tris grynąsias UI funkcijas, kurios jų neturi, nors yra pigiai testuojamos
ir jomis remiasi matomas elgesys: maršruto parsinimas, šablonų užpildymas ir gedimų CSV.

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `ui-app/src/controller/useRoute.test.ts`
- `ui-app/src/model/fillTemplate.test.ts`
- `ui-app/src/model/failureCsv.test.ts`

Draudžiama:
- `ui-app/src/controller/useRoute.ts`
- `ui-app/src/model/fillTemplate.ts`
- `ui-app/src/model/failureCsv.ts`
- `src/**`
- `.env`

## Dependencies
depends_on: none

## Veiksmas
- Šis task'as PRIDEDA testus, o produkcinio kodo NEKEIČIA. Jei testas atskleidžia klaidą,
  ji aprašoma ataskaitoje kaip radinys — taisymas yra atskiras sprendimas, kad testas
  nebūtų pritemptas prie klaidingo elgesio.
- `useRoute`: hash'as be `#/` duoda `overview`; nežinomas maršrutas duoda `overview`, ne
  klaidą; kiekvienas iš dešimties žinomų maršrutų atpažįstamas; `navigate("overview")`
  išvalo hash'ą, o kiti maršrutai rašo `#/<route>`; `hashchange` atnaujina būseną.
- `ROUTE_LABELS` privalo turėti įrašą KIEKVIENAM `Route` variantui — be jo dokumento
  antraštė ir navigacijos skirtukas rodytų `undefined`. Tai vienintelis vartas, saugantis
  naujo maršruto pridėjimą (2026-08-26 pridėtas `compression` to parodė).
- `fillTemplate`: esantis raktas pakeičiamas; trūkstamas raktas nepalieka `undefined`
  tekste; pasikartojantis raktas keičiamas visur; tuščias šablonas grąžina tuščią eilutę.
- `failureCsv`: kableliai, kabutės ir naujos eilutės lauko viduje ekranuojami pagal CSV
  taisykles; tuščias sąrašas duoda antraštę be eilučių; laukų tvarka stabili.
- Testai rašomi projekto stiliumi (`vitest`, gretimas failas šalia modulio).

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei testas atskleistų realią klaidą — įvardyk ją
ataskaitoje ir NEKEISK produkcinio kodo šiame task'e.

## Neįtraukta
- Produkcinio kodo taisymai.
- Komponentų (`Header`, `MoreMenu` ir kt.) testai — jie dengiami netiesiogiai.
- Backend testai.
