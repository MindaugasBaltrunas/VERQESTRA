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
`AgentChainProgress` rodo antrą lygiagrečią agentų grandinės juostą, kai banga turi aktyvų `w2` slot'ą (w2 task id + dabartinė fazė). Sequential režime vaizdas lieka identiškas dabartiniam — jokio tuščio w2 bloko.

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/AgentChainProgress.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/useAgentActivity.ts`
- `ui-app/src/view/components/OverviewPanel.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Perskaityk `ui-app/src/model/types.ts` `SlotAgentActivity` / `slots?: SlotAgentActivity[]` kontraktą ir imk w2 duomenis iš jo — naujų tipų nekurk.
- `AgentChainProgress`: kai `slots` turi gyvą `w2` įrašą, atvaizduok antrą juostą su w2 task id ir faze; kai jo nėra, render'is nesikeičia.
- Naujiems tekstams pridėk `t(...)` raktus en+lt, naujoms `className` — taisykles `dashboard.css` abiem temoms, be amžinų animacijų.

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
STOP, jei `SlotAgentActivity` neturi w2 fazės/task lauko ir reikėtų keisti serverio kontraktą (`src/**`). Kitaip commit'ink, kai abi patikros žalios.

## Neįtraukta
Aktyvaus vykdymo sekcija (`useAgentActivity`, `DashboardPage`) ir `OverviewPanel` signalai — atskiros nuoseklios užduotys. Serverio projekcijos (065). Scheduling elgsena. Mobile gateway.
