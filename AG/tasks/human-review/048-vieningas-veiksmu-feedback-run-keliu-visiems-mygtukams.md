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

## Žingsnis 0 — ar jau įgyvendinta?
Jei `resumeLoop` ir `reload` eina per tą patį `useOperatorActions.run()` kelią
(pending užraktas + toast), o `canResume` skaičiuojamas iš ciklo BŪSENOS, ne iš
etiketės teksto — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas: veiksmai be grįžtamojo ryšio ir be apsaugos.
(a) `resumeLoop` (`ui-app/src/controller/useDashboardController.ts:238-252`)
apeina `run()` — nėra `pendingActions` užrakto (du greiti paspaudimai = dvi POST)
ir jokio toast'o. (b) „Atnaujinti būseną"/„Tikrinti dar kartą"
(`RuntimePanel.tsx:182,267`) kviečia `actions.reload()` be jokio busy/klaidos
signalo prie mygtuko — klaida rodoma tik puslapio viršuje. (c) `canResume`
lygina etiketės TEKSTĄ (`useDashboardController.ts:67-77`:
`resumeLabel === "▶ Start loop"`) — po klaidos mygtukas užsidaro dėl teksto.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/controller/useDashboardController.ts`
- `ui-app/src/controller/useOperatorActions.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/i18n/I18nContext.tsx` (nauji vertimo raktai naujoms žinutėms — be jų
  `i18n/coverage.test.ts` raudonas; etikečių suvienijimas lieka 049)
- `ui-app/src/tests/dashboardActionFeedback.test.ts`

Draudžiama:
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `resumeLoop` perleisti per `run()` (kaip `stopLoop`/`startLoopWithWorkers`).
- `reload` mygtukams: `aria-busy` + disabled kol vyksta; nesėkmė — žinutė prie
  mygtuko arba toast, ne tik `refreshError` juosta viršuje.
- `canResume` išvesti iš `loopRunState`/pending būsenos, ne iš `resumeLabel`.
- Testai: dvigubas paspaudimas siunčia vieną POST; klaidos būsena neužrakina
  mygtuko amžinai.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios.

## Neįtraukta
Dviejų „Paleisti" kelių suvienijimas ir etikečių i18n (049). Per-proceso
„Tikrinti dar kartą" semantika (052).
