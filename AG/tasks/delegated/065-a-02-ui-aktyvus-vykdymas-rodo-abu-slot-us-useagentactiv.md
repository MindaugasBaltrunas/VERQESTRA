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
„Aktyvus vykdymas" sekcija rodo ABU aktyvius slot'us: worker id, task id, modelis, worktree kelias (w2) ir bėgimo trukmė. Kai gyvas tik w1, vaizdas lieka toks pat kaip dabar.

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/controller/useAgentActivity.ts`
- `ui-app/src/controller/useAgentActivity.test.ts`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/OverviewPanel.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `useAgentActivity`: grąžink visų gyvų slot'ų sąrašą iš `/api/events` kadro `slots[]` (`SlotAgentActivity`), o ne vien globalų aktyvumą; trūkstamus laukus laikyk neprivalomais.
- `DashboardPage` aktyvaus vykdymo sekcijoje render'ink kiekvieną slot'ą su worker id, task id, modeliu, worktree keliu ir trukme.
- Naujiems tekstams `t(...)` raktai en+lt, naujoms `className` — taisyklės `dashboard.css` abiem temoms.

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
STOP, jei reikėtų keisti `/api/events` krovinį serveryje (`src/**`). Kitaip commit'ink, kai abi patikros žalios.

## Neįtraukta
`AgentChainProgress` w2 juosta ir `OverviewPanel` signalai — atskiros užduotys. Serverio projekcijos (065). Istorinių bangų archyvas.
