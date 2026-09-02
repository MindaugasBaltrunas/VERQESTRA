## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: operatorius 2026-09-02 „aš visus tasks approve" (dependency vartai: ui-app/package.json)

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/package.json` `devDependencies` turi `@types/node` ARBA
`ui-app/tsconfig.app.json` (ar atskirta testų tsconfig) turi aiškų
`"types": ["node"]` su lokaliai išsprendžiamu tipų paketu —
ALREADY_IMPLEMENTED: cituok atitinkamą bloką kaip įrodymą.

## Tikslas
UI audito P0 (docs/audits/ui-app-2026-08-31/report.md, „P0 — `pnpm --dir
ui-app build` nepraeina"): audito aplinkoje `tsc -b` fazė krito ant
`ui-app/src/i18n/coverage.test.ts`, `ui-app/src/model/apiEnvelopes.test.ts` ir
`ui-app/src/view/components/dashboard-css-coverage.test.ts` — jie importuoja
`node:path`/`node:url`, o `@types/node` ui-app'e nėra. Patikrinta 2026-09-01:
`ui-app/package.json` devDependencies (17-27 eil.) `@types/node` NETURI —
paketas deklaruotas tik šakniniame `package.json` (56 eil., `^22.15.29`) ir
kituose workspace'uose, tad ui-app `tsc` jį randa tik per node_modules paiešką
aukštyn. Tai aplinkos loterija: vienur build praeina, kitur (audito aplinka,
kur lokaliame `ui-app/node_modules/@types/` yra tik react/react-dom) — krinta.
`ui-app/tsconfig.app.json` `include: ["src"]` (22 eil.) įtraukia ir testus,
tad vartas nuo šios priklausomybės neatsiejamas. Sprendimo kryptis pagal
report rekomendaciją: `@types/node` į `ui-app` devDependencies IR aiškus Node
tipų deklaravimas testų konfigūracijoje (arba testų tsconfig atskyrimas) —
release vartas privalo praeiti standartine komanda bet kurioje aplinkoje.
ŠIS TASK'AS AIŠKIAI APIMA dependency keitimą (`ui-app/package.json`
devDependencies) — tai jo esmė, ne šalutinis efektas.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/package.json` (TIK devDependencies `@types/node` eilutė)
- `ui-app/tsconfig.app.json`
- `ui-app/tsconfig.json`
- `ui-app/tsconfig.test.json` (numatomas naujas — TIK jei pasirenkamas testų
  tsconfig atskyrimas; jei ne, failas nekuriamas, įrašyti į ataskaitą)

Draudžiama:
- `package.json` (šakninis — jo `@types/node` lieka kaip yra)
- `pnpm-lock.yaml` rankinis redagavimas (lock'ą atnaujina `pnpm install`)
- `ui-app/src/**` (testų importai teisingi — problema konfigūracijoje)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ui-app/package.json`: į devDependencies pridėti `@types/node` ta pačia
  versija kaip šakninis (`^22.15.29`) — versijų dreifas tarp workspace'ų
  duotų du skirtingus Node tipų rinkinius.
- Pagal report rekomendaciją apsispręsti (ir ataskaitoje užfiksuoti):
  (a) `tsconfig.app.json` gauna aiškų `"types"` sąrašą su `node`, arba
  (b) testai iškeliami į atskirą `tsconfig.test.json` su `"types": ["node"]`,
  o `tsconfig.json` references atnaujinami. Kriterijus: `tsc -b` privalo
  matyti Node tipus visiems trims testų failams, o aplikacijos kodas
  neprivalo jų gauti globaliai.
- ŽINOMAS OPERATORIAUS ŽINGSNIS: po `package.json` keitimo reikalingas
  `pnpm install` — įrašyti į ataskaitą kaip likusį veiksmą, jei aplinkoje
  install nepaleidžiamas.
- Testų lūkestis: `pnpm --dir ui-app build` (tsc -b && vite build) praeina;
  esami ui-app testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir pranešk, jei be `pnpm install`
(kurio aplinka neleidžia) `pnpm --dir ui-app build` lieka raudonas dėl
neįdiegto paketo — tada pakeitimas teisingas, o žalias vartas atsiras po
operatoriaus install žingsnio; tai užfiksuoti ataskaitoje, ne bandyti apeiti.

## Neįtraukta
- Kitų ui-app devDependencies auditas ar versijų kėlimas — tik `@types/node`.
- `pnpm test` šakninio varto keitimai (`gate-covers-ui-app.test.ts` invariantas
  lieka koks yra).
- mobile-* paketų analogiška patikra — jei ten ta pati spraga, atskiras
  task'as.
