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
`SlotProgressCard.tsx:134` visada piešia `EtaBadge`, bet `DashboardPage.tsx:69-79` `etas` neperduoda — `resolveEta(undefined)` visada grąžina `{state:"unavailable"}`, tad kiekvienoje srauto kortelėje kabo negyvas valdiklis. Reikia vieno sprendimo: arba `etas` perduodamas iš `DashboardPage`, arba `EtaBadge` nepiešiamas, kol šaltinio nėra.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/SlotProgressCard.tsx`
- `ui-app/src/view/components/SlotProgressCard.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Nustatyk, ar `DashboardPage` prieinamuose duomenyse ETA šaltinis apskritai egzistuoja; jei taip — perduok `etas` iki kortelės, jei ne — nepiešk `EtaBadge`, kol `etas` neperduotas.
- Pasirinktą sprendimą pagrįsk komentaru prie pakeitimo (kodėl būtent šis, o ne antras variantas).
- Testuose padenk abi būsenas: su ETA duomenimis ženklelis rodomas, be jų — kortelėje jo nėra.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei ETA duomenims reikėtų naujo API lauko arba `ui-app/src/model/api.ts` keitimo — tai backend'o darbas ir į šią užduotį neįeina.

## Neįtraukta
ETA skaičiavimo backend'as. LoopControls W1/W2 (ankstesnės užduotys). Drain/abort mygtukai (050).
