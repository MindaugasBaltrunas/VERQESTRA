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
Tuščios `#/system` bangų lentelės nustoja tylėti: vietoj „No active leases" ir „No wave events recorded" rodoma priežastis, kodėl duomenų nėra ir kada jų atsiras.

## Agentai
Privaloma grandinė (naudok būtent ją, iš eilės): `readme-guard -> architect -> coder -> reviewer -> i18n -> tester`.

## Failai
Leidžiama:
- `ui-app/src/model/types.ts`
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/WavesPanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `types.ts`: pridėk lauką pagal jau egzistuojantį serverio kontraktą `src/interfaces/http/ui-waves-view.ts` — `worktree_policy?: { enabled: boolean; config_path: string }`; laukas NEPRIVALOMAS, nes degraduotas šaltinis įrašomas į `degraded` kaip `"worktree_policy"`, ir nežinoma reikšmė neturi apsimesti „išjungta".
- `WavesPanel.tsx`: tuščią lease'ų lentelę (`WavesPanel.tsx:151`) keisk trimis atvejais per `t(...)` — politika išjungta (įvardink `config_path` ir kad antras srautas nepakils), politika įjungta (lease'ų dar nėra), politikos būsena nežinoma (degraded); tuščias „Bangų detalės" blokas (`WavesPanel.tsx:209`) turi pasakyti, kada įvykių atsiras. Visus naujus tekstus registruok `I18nContext.tsx`.
- Kiekvienai naujai `className` parašyk taisyklę `dashboard.css` abiem temoms — `dashboard-css-coverage.test.ts` yra vartas.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app build`

Tester privalo uždengti: tuščia lentelė su išjungta politika, tuščia su įjungta politika, tuščia be `worktree_policy` lauko (degraded) ir lentelė su duomenimis.

## Stop
Commit'ink tik kai visos trys patikros žalios. Sustok ir klausk, jei kuris nors patikros žingsnis reikalautų keisti `src/**` arba silpninti esamą testą/vartą.

## Neįtraukta
Serverio pusė (`src/interfaces/http/ui-waves-view.ts`) jau padaryta ankstesnėje užduotyje — jos neliesk. Animacija, mygtukai ir `details` blokai — vėlesnės užduotys.
