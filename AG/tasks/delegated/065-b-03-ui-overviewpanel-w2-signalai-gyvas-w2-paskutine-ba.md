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
openspec/changes/verqestra-backlog-v1

## Tikslas
„Pagrindiniai signalai" (`OverviewPanel`) rodo: `w2: <task> (Xm)` kai w2 gyvas; paskutinę w2 baigtį (`merged` / `parked: <priežastis>` / `child exit <kodas>`); bangos režimą (`sequential` / `parallel 2/2`).

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/OverviewPanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/useAgentActivity.ts`
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Imk w2 būseną ir bangos režimą iš esamų `ui-app/src/model/types.ts` kontraktų (`SlotAgentActivity`, `UiWaveSlot`, `LoopSlotData`) — naujų serverio laukų neprašyk.
- `OverviewPanel`: pridėk tris signalus (gyvas w2 su trukme, paskutinė w2 baigtis, bangos režimas); kai w2 duomenų nėra, eilutės nerodomos.
- Naujiems tekstams `t(...)` raktai en+lt, naujoms `className` — taisyklės `dashboard.css` abiem temoms.

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
STOP, jei baigties priežasties (`parked` / `child exit`) serveris per esamus tipus neatiduoda ir reikėtų `src/**` pakeitimo. Kitaip commit'ink, kai abi patikros žalios.

## Neįtraukta
`AgentChainProgress` ir aktyvaus vykdymo sekcija — ankstesnės užduotys. Serverio projekcijos (065). Scheduling elgsena. Mobile gateway.
