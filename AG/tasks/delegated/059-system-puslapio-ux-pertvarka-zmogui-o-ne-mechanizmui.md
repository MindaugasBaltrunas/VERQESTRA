## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
`#/system` viršuje nėra atsakymo į vienintelį operatoriaus klausimą — kas vyksta DABAR ir ko iš manęs reikia. Sukurti `SystemStatusHero` bloką puslapio viršuje: vykdomas task'as (arba „ciklas sustojęs — priežastis"), kiek eilėje, kiek laukia žmogaus sprendimo (nuoroda į Reviews) ir VIENAS kontekstinis veiksmas (pvz. „Paleisti ciklą", kai sustojęs dėl atblokuotų task'ų). Duomenys jau yra dashboard snapshot'e — serverio ir controller sluoksnio keisti NEreikia. Dizaino kartelė kaip 056: Linear / Stripe Dashboard / Vercel Geist — aiški hierarchija, ramios spalvos per esamus design token'us, abi temos.

## Agentai
Privaloma grandinė: `readme-guard -> architect -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/SystemStatusHero.tsx`
- `ui-app/src/view/components/SystemStatusHero.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `ui-app/src/model/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: hero informacijos hierarchija ir kurie snapshot laukai ją maitina; nieko nešalina, tik įvardija.
- Coder: `SystemStatusHero.tsx` + įstatymas `DashboardPage.tsx` viršuje; kiekviena nauja className turi taisyklę `dashboard.css`; visi tekstai per `t(...)`.
- Tester: `SystemStatusHero.test.tsx` dengia tris scenarijus — ciklas vykdo / sustojęs dėl approval / sustojęs be darbo — ir kontekstinio veiksmo mygtuko rodymą.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai visos trys patikros žalios. Stop ir klausk, jei hero pareikalautų naujo controller lauko arba serverio kontrakto pakeitimo.

## Neįtraukta
Tuščių lentelių priežastys, „User Claude terminal" blokas, begalinė animacija, mygtukų pasekmių subtekstas, vidinių detalių kėlimas į `details` blokus — atskiros nuoseklios užduotys.
