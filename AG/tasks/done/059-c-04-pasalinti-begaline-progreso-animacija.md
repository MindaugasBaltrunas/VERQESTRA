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
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
`#/system` puslapyje indeterminate progreso juosta (`ProgressBar.tsx`, signal "indeterminate") be pabaigos sukasi net kai realių duomenų nėra. Pakeisti sąžininga būsena: kai duomenų nėra, rodyti tik statinį tekstą (esamas `t("Progress unknown")`), be jokios begalinės animacijos.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/ProgressBar.tsx`
- `ui-app/src/view/components/ProgressBar.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `ui-app/src/model/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: `ProgressBar.tsx` indeterminate atveju nebepiešti `.progress-bar__fill` su `progress-sweep` animacija; palikti/rodyti tik statinę tekstinę būseną per `t(...)`.
- Coder: `dashboard.css` pašalinti `.progress-bar--indeterminate .progress-bar__fill` animacijos taisyklę, `@keyframes progress-sweep` ir juos taikantį `prefers-reduced-motion` overridą, jei po pakeitimo tampa nenaudojami.
- Tester: atnaujinti `ProgressBar.test.tsx`, kad tvirtintų — indeterminate atveju nerenderinama jokia begalinę animaciją turinti klasė, tik statinis tekstas.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad `progress-sweep` animacija naudojama ir kitur už `progress-bar--indeterminate` ribų.

## Neįtraukta
Kiti System puslapio defektai; `slotProgressViewModel.ts` signalo tipo keitimas (nereikalingas — keičiasi tik renderinimas).
