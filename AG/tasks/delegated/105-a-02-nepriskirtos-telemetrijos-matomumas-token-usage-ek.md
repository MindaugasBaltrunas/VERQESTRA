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

## Spec source
openspec/changes/verqestra-backlog-v1/ — UI audito P1 „Analitika nesutaria dėl užduočių skaičiaus" (docs/audits/ui-app-2026-08-31/report.md).

## Tikslas
Tęsinys po `105-analitika-tuscia-task-id-viena-taisykle-visoms-agregacijoms` (model dalis): `tokenUsageViewModel.ts` jau atmeta tuščią `task_id` visose agregacijose ir grąžina nepriskirtų įrašų kiekį. Dabar Token Usage ekranas turi tai parodyti nuosekliai: lentelės suvestinė („140 užduočių") privalo remtis ta pačia grupių aibe kaip KPI kortelė „UNIKALIOS UŽDUOTYS", o atmesti be užduoties įrašai (rinkinyje jų buvo 161) turi būti matomi kaip aiškus paaiškinimas, ne tylus praradimas. Jei model sluoksnis dar neturi nepriskirtų įrašų kiekio, sustok — pirma turi būti baigtas model task'as.

## Agentai
Privaloma grandinė (naudok būtent ją, iš eilės): readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/TokenUsagePage.tsx`
- `ui-app/src/view/pages/TokenUsagePage.test.tsx`
- `ui-app/src/view/components/TopTasksTable.tsx`
- `ui-app/src/view/components/TopTasksTable.test.tsx`
- `ui-app/src/view/components/TokenUsageSummaryPanel.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/model/tokenUsageViewModel.ts`
- `ui-app/src/model/tokenUsageViewModel.test.ts`
- `ui-app/src/model/apiEnvelopes.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `TopTasksTable.tsx` (89 eil. suvestinė) ir `TokenUsageSummaryPanel.tsx` (36-37 eil. KPI): abu skaičiai imami iš tos pačios normalizuotos aibės, kad lentelės „N užduočių" ir „UNIKALIOS UŽDUOTYS" sutaptų; vidurkiai rodomi vienodi.
- `TokenUsagePage.tsx` + `TopTasksTable.tsx`: parodyk nepriskirtų (be `task_id`) įrašų kiekį kaip atskirą paaiškinimą po lentele; tekstas per i18n raktą `I18nContext.tsx` (visos palaikomos kalbos), stilius — nauja klasė `dashboard.css`, jei reikia (kiekviena nauja className privalo turėti taisyklę).
- Testai `TopTasksTable.test.tsx` ir `TokenUsagePage.test.tsx`: rinkinys su tuščio `task_id` įrašais — lentelėje nėra tuščios grupės eilutės, suvestinės skaičius lygus KPI unikalių užduočių skaičiui, nepriskirtų įrašų kiekis atvaizduotas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok ir klausk, jei paaiškėtų, kad reikia keisti `tokenUsageViewModel.ts` kontraktą arba serverio pusės eksporto/API formą — tai jau ne šio task'o scope.

## Neįtraukta
- Bet koks `ui-app/src/model/**` keitimas — normalizavimo taisyklė baigta pirmame task'e.
- Telemetrijos rašytojai `src/**`.
- `phase`/`model`/`day` grupavimo ir „naujausi 500 iš 795" semantikos keitimai.
