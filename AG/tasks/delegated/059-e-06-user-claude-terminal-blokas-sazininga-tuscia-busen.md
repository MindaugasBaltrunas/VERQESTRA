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
„User Claude terminal" kortelė RuntimePanel komponente (`#/system` puslapis) šiuo metu be sesijos rodo bendrinį tekstą „The process state could not be confirmed." ir turi `.runtime-card:hover` pakėlimo/šešėlio efektą, nors kortelė neturi jokio `onClick` — tai atrodo kaip paspaudžiamas elementas, bet nieko nedaro. Pataisyk taip, kad be sesijos kortelė aiškiai paaiškintų save (per `t(...)`): tai stebėjimo blokas, kuris rodys vartotojo paleistą Claude terminalo sesiją, o dabar jos nėra — ir pašalink ar neutralizuok paspaudžiamumo įspūdį (hover/pointer) šiai neveiksniai kortelei.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: RuntimePanel.tsx `statusDescription`/atitinkamoje vietoje specialiai apdoroti „User Claude terminal" kortelę, kai jos statusas nėra „running" — rodyti per `t(...)` paaiškinantį tekstą apie tai, kad blokas stebi vartotojo paleistą Claude sesiją ir dabar jos nėra; pašalinti šiai kortelei paspaudžiamumo (`:hover` pakėlimas/šešėlis) įspūdį, nekeičiant kitų (AG UI, AG loop) kortelių elgesio.
- Coder: kiekviena nauja className turi turėti taisyklę `dashboard.css` abiem temoms (šviesiai ir tamsiai), naujos vertimo eilutės pridedamos į `I18nContext.tsx`.
- Tester: RuntimePanel.test.tsx papildyti atveju be sesijos (unknown/stopped statusas) ir su aktyvia sesija (running statusas), patikrinant, kad rodomas naujas paaiškinamasis tekstas ir kad kortelė nebeturi klaidinančio hover efekto.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad blokas ar jo elgsena gyvena už leidžiamų failų ribų (pvz. reikėtų liesti `ui-app/src/controller/**`).

## Neįtraukta
Vidinių detalių kėlimas į `details` blokus — atskira, vėlesnė užduotis.
