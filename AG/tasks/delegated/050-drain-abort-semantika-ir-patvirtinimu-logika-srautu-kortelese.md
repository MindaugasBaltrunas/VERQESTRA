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
Jei srauto kortelėse nebėra „Nutraukti" mygtuko, žadančio neegzistuojantį
force-abort (arba jis aiškiai pažymėtas kaip drain alias be danger tono), W1
drain (kuris stabdo visą ciklą) turi patvirtinimą, o drain leidžiamas ir tuščiam
slot'ui — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas, `ui-app/src/view/components/LoopStreamCards.tsx`:
(a) „Nutraukti srautą" (`:154-162`, `tone="danger"`, su ConfirmButton) rašo
`mode:"abort"`, bet panelė pati sako, kad tai identiška `drain` ir „real
force-abort is not implemented" (`:176-178`) — mygtukas žada veiksmą, kurio nėra.
(b) Patvirtinimų logika apversta: „Stabdyti srautą (drain)" (`:118-127`) W1
atveju sustabdo VISĄ ciklą (pripažinta `:83-87`), bet vykdomas VIENU paspaudimu.
(c) `disabled={... || !hasWork}` (`:120`) neleidžia drain'inti tuščio slot'o,
nors drain yra norimos būsenos įrašas — uždrausti slot'ui imti KITĄ užduotį
yra prasmingas veiksmas.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/LoopStreamCards.tsx`
- `ui-app/src/view/components/LoopStreamCards.test.tsx`
- `ui-app/src/model/loopControlsViewModel.ts`
- `ui-app/src/model/loopControlsViewModel.test.ts`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pašalinti „Nutraukti" mygtuką ARBA pervadinti į drain-alias be danger tono su
  paaiškinimu (kol serveris neturi tikro abort) — vienas sprendimas, dokumentuotas
  komponento komentare.
- W1 drain: ConfirmButton su tekstu, kad tai sustabdys visą ciklą.
- Nuimti `!hasWork` iš drain disabled sąlygos; tuščio slot'o drain — leidžiamas.
- Testai: W1 drain reikalauja patvirtinimo; tuščias slot'as drain'inamas.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sprendimas imtų reikalauti
tikro force-abort serveryje — tai atskiras backend task'as.

## Neįtraukta
Serverio `slots/:workerId` semantikos keitimas. LoopControls W1/W2 pasirinkimas (051).
