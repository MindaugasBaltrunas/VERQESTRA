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

## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode. Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Spec source
`AG/openspec/changes/verqestra-backlog-v1/`

## Tikslas
`#/system` ciklo mygtukai (Start/Stop/Restart) privalo turėti vieną bendrą šabloną: Stop drain semantikos paaiškinimas prie paties mygtuko (visada matomas subtekstas), o kiekvienas išjungtas mygtukas — `title` su priežastimi.

## Agentai
readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/view/components/LoopControls.test.tsx`
- `ui-app/src/view/components/ConfirmButton.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Patikrink `LoopControls.tsx`: bendras `LoopActionButton` šablonas, `title` išjungtiems mygtukams, Stop subtekstas — jei visa tai jau yra (patikrink `LoopActionButton` funkciją ir `LoopControls.test.tsx` testą su komentaru "Task 059-d"), pažymėk ALREADY_IMPLEMENTED ir nieko nekeisk.
- Jei ko nors trūksta, papildyk minimaliai laikydamasis to paties šablono visiems trims mygtukams ir pridėk trūkstamą `dashboard.css` taisyklę bei testą.
- Nekeisk `ui-app/src/controller/**` ar `src/**`.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink tik jei buvo realus pakeitimas ir patikros žalios. Jei ALREADY_IMPLEMENTED — nieko necommitink, tik ataskaita.

## Neįtraukta
Kiti System puslapio defektai.
