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
Tame pačiame rinkinyje KPI rodo „UNIKALIOS UŽDUOTYS: 139", o lentelės suvestinė „140 užduočių", nes `computeTokenUsageTotals` tuščią `task_id` praleidžia, o `aggregateTokenUsage` grupuoja pagal žalią `record[groupBy]` (73 eil.) ir tuščia eilutė tampa atskira grupe. Įvesk VIENĄ normalizavimo taisyklę `ui-app/src/model/tokenUsageViewModel.ts`, kurią naudoja abu keliai, kad unikalių užduočių skaičius, task_id grupių skaičius ir abu tokenų/užduočiai vidurkiai būtų skaičiuojami iš TOS PAČIOS aibės. Kryptis nustatyta: tuščias/whitespace `task_id` atmetamas VISUR — `tokenUsageViewModel.test.ts:201-220` (2026-08-24 pamoka) užrakina, kad toks įrašas nėra užduotis, ir tas testas nesilpninamas. Kad nepriskirta telemetrija nedingtų tyliai, `computeTokenUsageTotals` papildomai grąžina atmestų (be užduoties) įrašų kiekį — jo atvaizdavimas paliekamas kitam task'ui.

## Agentai
Privaloma grandinė (naudok būtent ją, iš eilės): readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/tokenUsageViewModel.ts`
- `ui-app/src/model/tokenUsageViewModel.test.ts`

Draudžiama:
- `src/**`
- `ui-app/src/model/apiEnvelopes.ts`
- `ui-app/src/view/pages/TokenUsagePage.tsx`
- `ui-app/src/view/components/TopTasksTable.tsx`
- `ui-app/src/view/components/TokenUsageSummaryPanel.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `tokenUsageViewModel.ts`: pridėk vieną eksportuotą funkciją (pvz. `normalizeTaskId(raw): string | null` — trim, tuščią grąžina `null`) ir taikyk ją PRIEŠ visas task_id agregacijas: grupavimo rakte (57-74 eil., kai `groupBy === "task_id"` — įrašai su `null` į grupes nepatenka) ir `computeTokenUsageTotals` `uniqueTasks` skaičiavime (162 eil.), kad likusi logika naudotų tą pačią funkciją, o ne savo tikrinimą.
- Papildyk totals tipą nauju lauku su nepriskirtų (atmestų) įrašų kiekiu; esamų laukų prasmės ir vardų nekeisk (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, Record prieiga per bracket).
- `tokenUsageViewModel.test.ts`: pridėk testus — rinkinyje su tuščio ir whitespace `task_id` įrašais (1) `uniqueTasks` sutampa su task_id grupių skaičiumi (139≠140 klasės regresija), (2) tokenai vienai užduočiai iš totals ir iš grupių sutampa, (3) nepriskirtų įrašų kiekis atitinka; esami 201-220 eil. testai lieka nepakeisti ir žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok ir klausk, jei tuščio ID atmetimas grupavime reikalautų keisti serverio pusės kontraktą (CSV eksportą ar API formą) arba jei kuris nors 2026-08-24 pamokos testas neišvengiamai raudonėtų — testas nesilpninamas.

## Neįtraukta
- View sluoksnis (`TokenUsagePage.tsx`, `TopTasksTable.tsx`, `TokenUsageSummaryPanel.tsx`), i18n raktai ir `dashboard.css` — atskiras sekantis task'as.
- Telemetrijos rašytojai `src/**`: įrašas be `task_id` yra teisėta fazių telemetrija.
- `phase`/`model`/`day` grupavimo normalizacija ir „naujausi 500 iš 795" semantika.
