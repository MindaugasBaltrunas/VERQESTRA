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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Audituoti bendrus dashboard UI resursus pagal 2026-08-28 operatoriaus reikalavimus, punktai 5 ir 10:
5. Jokių `QueuePipelineBoard` liekanų CSS taisyklėse ir i18n raktuose.
10. `dashboard.css` be amžinų (`infinite`) animacijų, išskyrus spinner/skeleton.
Rezultatas — ataskaita, kurioje kiekvienas punktas pažymėtas ✅/❌ su `failas:eilutė` įrodymu, plius smulkūs pataisymai leidžiamų failų ribose (mirusi CSS taisyklė be skaitytojo, nenaudojamas i18n raktas, amžina animacija).

## Agentai
PRIVALOMA grandinė: readme-guard -> reviewer -> coder -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/components/dashboard-css-coverage.test.ts`
- `ui-app/src/i18n/coverage.test.ts`

Draudžiama:
- `ui-app/src/view/components/QueuePipelineBoard.tsx`
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Grep `queue-pipeline` / `queuePipeline` per `dashboard.css` ir `I18nContext.tsx`; kiekvieną rastą taisyklę ar raktą patikrinti, ar turi gyvą skaitytoją TSX'e, ir mirusius pašalinti.
- Grep `infinite` per `dashboard.css`; kiekvienai animacijai nurodyti, ar tai spinner/skeleton (leidžiama), ar amžinas pulsavimas (šalinti).
- Parašyti ataskaitą: punktai 5 ir 10 su ✅/❌ ir `failas:eilutė` įrodymu; radinius už leidžiamų failų ribų (pvz. likęs `QueuePipelineBoard.tsx` be skaitytojo) tik įrašyti su siūlomu atskiru task'u, NETAISYTI.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios ir ataskaitoje punktai 5 ir 10 pažymėti su įrodymais. Sustok ir klausk, jei pataisa reikalautų liesti komponentų TSX failus arba silpninti `dashboard-css-coverage.test.ts`.

## Neįtraukta
Komponentų TSX auditas (punktai 1–4, 6–9) — atskiruose task'uose 069-b…069-e. Galutinis `pnpm --dir ui-app build` — task'e 069-f. Serverio kodas, mobile, dideli funkciniai pakeitimai.
