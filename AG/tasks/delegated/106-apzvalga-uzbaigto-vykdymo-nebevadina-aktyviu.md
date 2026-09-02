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
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 105-analitika-tuscia-task-id-viena-taisykle-visoms-agregacijoms

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/AgentChainProgress.tsx` sekcijos antraštė
(dabar 80 eil.) yra sąlyginė — ne-gyvai būsenai (pvz. `finished`) rodoma
„Paskutinis vykdymas" tipo etiketė, o „Stream unknown" atribucija tokioje
būsenoje slepiama — ALREADY_IMPLEMENTED: cituok sąlyginį JSX ir I18n raktus
kaip įrodymą.

## Tikslas
UI audito P2 (docs/audits/ui-app-2026-08-31/report.md, „Apžvalga ‚aktyviu
vykdymu' vadina užbaigtą būseną"): sekcijoje „Aktyvus vykdymas" kartu rodoma
`finished`, „Srautas nežinomas", užduotis jau `done` — užbaigtas darbas
atrodo kaip vykstantis. Patikrinta 2026-09-01: antraštė gyvena NE
OverviewPanel, o `ui-app/src/view/components/AgentChainProgress.tsx` —
`<h2>{t("Active execution")}</h2>` 80 eil. (I18nContext.tsx:139 „Aktyvus
vykdymas"); komponentas JAU skiria gyvą būseną nuo ne-gyvos —
`isLiveStatus` regex 72 eil. (`started|running|active|dispatch|preflight|
delegated`; `finished` į ją nepatenka), bet antraštė ir atribucijos ženklelis
(86-90 eil., „Stream unknown" fallback) besąlyginiai. Sprendimas pagal report:
kai vykdymas užbaigtas (`claudeStatus` yra `finished` / ne-gyvas, o grandinė
neaktyvi), antraštė — „Paskutinis vykdymas" (naujas i18n raktas), neaktuali
srauto atribucijos etiketė slepiama, o užbaigtos grandinės rezultatas
vizualiai atskiriamas nuo aktyvaus progreso.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/AgentChainProgress.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx` (naujas raktas „Last execution")
- `ui-app/src/view/styles/dashboard.css` (jei užbaigtos būsenos atskyrimui
  reikia naujos klasės)

Draudžiama:
- `ui-app/src/controller/useAgentActivity.ts` (būsenos šaltinis teisingas —
  keičiasi tik pateikimas)
- `ui-app/src/view/components/SlotProgressCard.tsx` (savo „Stream unknown"
  naudojimą turi kitame kontekste — neliečiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `AgentChainProgress.tsx`: išvesti užbaigtos būsenos sąlygą iš JAU esamų
  signalų (`claudeStatus`, `isLiveStatus` 72 eil., `chain`/`statuses`) ir
  pagal ją: (1) h2 tekstas — „Active execution" gyvai būsenai, „Last
  execution" užbaigtai; (2) atribucijos ženklelis (86-90 eil.) nerodomas,
  kai vykdymas užbaigtas ir srauto etiketė nebeaktuali; (3) grandinės
  žingsnių pateikimas užbaigtoje būsenoje neturi atrodyti kaip laukiantis
  progresas.
- `I18nContext.tsx`: EN sentinelė „Last execution" su LT vertimu
  „Paskutinis vykdymas".
- Testų lūkestis: (1) `claudeStatus: "finished"` → antraštė „Last execution"
  (LT: „Paskutinis vykdymas"), atribucijos etiketės nėra; (2) gyva būsena
  (`running`/`dispatch`) → antraštė „Active execution" ir esamas elgesys
  nepakitęs; (3) idle atvejis (107 eil. „Waiting for a task…") lieka koks
  buvęs.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pasirodytų, kad
`claudeStatus` reikšmių aibė nepakankama užbaigtai būsenai atskirti (pvz.
`finished` niekada neateina, o būsena matoma tik iš kitų laukų) — tada
signalo šaltinis būtų `useAgentActivity` kontrakto klausimas už šio task'o
ribų.

## Neįtraukta
- Agentų grandinės žingsnių būsenų skaičiavimo logika — tik pateikimas.
- `SlotProgressCard` „Stream unknown" semantika — ten ji turi savo taisykles
  ir testus (SlotProgressCard.test.tsx:139-152).
- OverviewPanel „Key signals" blokas — auditas jo neminėjo.
