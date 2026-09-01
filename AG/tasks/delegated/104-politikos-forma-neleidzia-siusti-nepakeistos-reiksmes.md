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
- 103-serveris-atmeta-no-op-politikos-pasiulyma

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/PolicyControlsPanel.tsx` „Siųsti" mygtukas
turi `disabled` sąlygą, lyginančią formos reikšmę su dabartine
(`control.value`), ir šalia rodomas paaiškinimas apie nepakeistą reikšmę —
ALREADY_IMPLEMENTED: cituok disabled sąlygą ir paaiškinimo JSX kaip įrodymą.

## Tikslas
UI audito P1 (docs/audits/ui-app-2026-08-31/report.md): atidarius „Siūlyti
pakeitimą" pradinis pasirinkimas sutampa su dabartine reikšme, peržiūra rodo
`layered → layered`, o „Siųsti" lieka aktyvus. Patikrinta 2026-09-01
`ui-app/src/view/components/PolicyControlsPanel.tsx`: submit mygtuko
`disabled={submitting}` (303 eil.) priklauso TIK nuo siuntimo būsenos —
jokio `formValue` palyginimo su `control.value`; `parseFormValue` (22-31
eil.) formos reikšmę jau moka paversti į palyginamą tipą. Serveris nuo task
103 no-op atmeta 4xx — UI be disable kiekvieną tokį paspaudimą paverstų
klaidos toast'u, nors teisingas elgesys yra neleisti paspausti ir pasakyti
kodėl. Sprendimas pagal report rekomendaciją: išjungti „Siųsti", kol nauja
reikšmė nesiskiria nuo dabartinės, ir šalia rodyti paaiškinimą „Pasirinkite
kitą reikšmę".

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx` (naujas paaiškinimo raktas)
- `ui-app/src/view/styles/dashboard.css` (paaiškinimo klasės taisyklė — CSS
  dengiamumo vartas)

Draudžiama:
- `ui-app/src/view/components/SelectMenu.tsx` (pasirinkimo valdiklio ARIA
  semantika gera — report tai pagyrė; nekeičiama)
- `src/**` (serverio pusė — task 103)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `PolicyControlsPanel.tsx`: išvesti `isNoOp` — `parseFormValue(control.value,
  formValue)` lygus `control.value`; „Siųsti" gauna
  `disabled={submitting || isNoOp}`; kai `isNoOp`, po mygtuku (ar šalia)
  rodomas paaiškinimas nauju i18n raktu (EN sentinelė, pvz. „Choose a
  different value", LT „Pasirinkite kitą reikšmę") su nauja className,
  aprašyta `dashboard.css`.
- Disabled būsena turi būti prieinama: paaiškinimas susietas su mygtuku
  (pvz. `aria-describedby`) — ekrano skaitytuvas turi girdėti priežastį.
- Testų lūkestis (`PolicyControlsPanel.test.tsx`): (1) atidarius formą su
  nepakeista reikšme „Siųsti" yra disabled ir matomas paaiškinimas;
  (2) pakeitus reikšmę mygtukas aktyvus, paaiškinimas dingsta; (3) grąžinus
  pradinę reikšmę — vėl disabled; (4) esami submit testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `control.value` tipų
aibėje rastųsi reikšmių, kurių `parseFormValue` negali normalizuoti palyginimui
(tada palyginimo taisyklė būtų kontrakto klausimas, sprendžiamas su 103 puse).

## Neįtraukta
- Serverio no-op atmetimas — task 103 (ši priklausomybė).
- Dubliuotų pending pasiūlymų grupavimas sąraše — atskiras task'as (žr. 103
  Neįtraukta).
- SelectMenu valdiklio elgesio ar ARIA keitimai — auditas juos įvertino
  teigiamai.
