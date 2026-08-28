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
openspec/changes/verqestra-backlog-v1/

## Tikslas
`#/reviews` policy pakeitimo formoje nelieka „Pakeitimo priežastis (privaloma)" lauko: forma yra tik SelectMenu + Send/Cancel. Serveris jau priima pasiūlymą be `reason`. Operatoriaus reikalavimas 2026-08-28: prievolė rašyti priežastį sau pačiam yra trintis be naudos.
Jei formoje „Change reason" lauko jau nėra — ALREADY_IMPLEMENTED.

## Agentai
Privaloma grandinė (nenukrypti): readme-guard -> coder -> reviewer -> i18n -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/model/api.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `ui-app/src/view/components/SelectMenu.tsx`
- `src/interfaces/http/ui-router-mutations.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Išimti textarea, „(required)" žymę, `reasonMissing` logiką ir su ja susijusius pagalbos tekstus bei nebenaudojamus i18n raktus abiejose kalbose; Send mygtukas nebeužrakinamas dėl priežasties.
- `api.ts`: propose užklausa nebesiunčia `reason`; tipai atitinkamai atnaujinami.
- `dashboard.css` — pašalinti tik su ištrintais elementais likusias klases; `PolicyControlsPanel.test.tsx` atnaujinti, kad tikrintų formą be priežasties lauko ir sėkmingą pasiūlymo siuntimą.

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios (CSS klasių dengiamumo vartas turi likti žalias). Sustok, jei tektų keisti SelectMenu elgesį ar serverio kelią.

## Neįtraukta
SelectMenu poliravimas (kita užduotis). Kiti Reviews blokai. Pasiūlymų atšaukimas (067).
