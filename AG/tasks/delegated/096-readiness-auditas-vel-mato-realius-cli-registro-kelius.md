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

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/quality/readiness-adapters.ts` `commandSources` sąraše
nebėra nė vieno `src/composition/cli-*.ts` kelio (visi rodo į
`src/composition/cli/registry.ts` ir `src/composition/cli/commands-*.ts`) IR
egzistuoja `src/tests/readiness-command-sources.test.ts` su patikra, kad
kiekvienas `commandSources` kelias egzistuoja realiame repo —
ALREADY_IMPLEMENTED: cituok atnaujintą `commandSources` bloką ir testo failo
assert'us kaip įrodymą.

## Tikslas
`readinessRequirements.commandSources` (`src/composition/quality/readiness-adapters.ts:150-160`,
patikrinta 2026-09-01) išvardija aštuonis NEEGZISTUOJANČIUS kelius
(`src/composition/cli-registry.ts`, `src/composition/cli-commands-spec.ts` ir kt.) —
Glob patvirtina, kad `src/composition/cli-*.ts` failų repo nėra; realūs failai gyvena
`src/composition/cli/` kataloge (`registry.ts` + septyni `commands-*.ts` su 73
`{ name: "..." }` registracijomis). Iš sąrašo egzistuoja tik `src/cli.ts`, kuris
registracijų neturi, todėl `runReadinessAudit`
(`src/application/release-readiness/readiness-audit.ts:96-101`) per
`readTextFileIfExists` negauna nė vieno registro turinio, `implemented_commands`
lieka tuščias ir auditas melagingai skelbia trūkstant visų dokumentuotų komandų
(`implementation:<komanda>` kiekvienai). Tai jau ANTRAS tos pačios klasės lūžis —
to paties failo 147-149 eil. komentaras fiksuoja identišką incidentą („11/N iškėlus
komandas… auditas tyliai nustojo matuoti"). Sprendimas: atnaujinti kelius Į realius
IR pridėti realaus repo integracinį testą, kuris fail-closed pagauna kelių dreifą
ateityje. Alternatyva „tik pataisyti kelius be testo" atmesta: du identiški
incidentai įrodo, kad be varto sąrašas dreifuoja tyliai.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/quality/readiness-adapters.ts`
- `src/tests/readiness-command-sources.test.ts` (numatomas naujas; jei
  konvencija pareikalautų kito vardo — tas failas vietoje šio, įrašyti į
  ataskaitą)

Draudžiama:
- `src/application/release-readiness/readiness-audit.ts` (parseris teisingas —
  testas jį tik importuoja)
- `src/composition/cli/registry.ts` ir `src/composition/cli/commands-*.ts`
  (registro turinys nekeičiamas)
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/composition/quality/readiness-adapters.ts` (`commandSources`, 150-160 eil.):
  pakeisti aštuonis mirusius `src/composition/cli-*.ts` kelius realiais —
  `src/composition/cli/registry.ts` ir septyni
  `src/composition/cli/commands-{spec,tasks,audit,ops,architecture,integrations,hooks}.ts`;
  `src/cli.ts` lieka. Dėl `src/composition/cli/main.ts` ir
  `src/composition/cli/registry-types.ts` spręsti pagal turinį: įtraukti TIK jei
  juose yra `{ name: "..." }` komandų registracijų (2026-09-01 Grep rodė 0 —
  greičiausiai neįtraukti, bet persitikrink).
- Ten pat: atnaujinti 116 eil. doc-komentarą, kuris vis dar mini
  `src/composition/cli-registry.ts`, į realų `src/composition/cli/` pjūvį.
- `src/tests/readiness-command-sources.test.ts` (naujas, realaus repo
  integracinis): (1) kiekvienam `readinessRequirements.commandSources` keliui
  assert'inti, kad failas egzistuoja repo šaknyje — dingęs/pervadintas kelias
  daro testą raudoną (fail closed prieš dreifą); (2) perskaityti tuos failus ir
  per `parseRegisteredCommands` assert'inti, kad rezultatas netuščias, o
  dokumentuotų (README `## Main Commands`) ir implementuotų komandų sankirta
  netuščia — t. y. auditas realiai matuoja, ne lygina su tuščia aibe.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei sutvarkius kelius
`parseRegisteredCommands` vis tiek grąžina tuščią aibę (tai reikštų parserio
regex'o spragą `src/application` sluoksnyje — už šio task'o ribų) arba jei
paaiškėtų, kad `commandSources` sąrašą reikia generuoti dinamiškai, o ne
deklaruoti (kontrakto keitimas).

## Neįtraukta
- `parseRegisteredCommands` / `runReadinessAudit` logikos keitimai
  (`src/application/release-readiness/readiness-audit.ts`) — parseris veikia,
  problema tik adapterio keliuose.
- README `## Main Commands` sinchronizacija su realiu registru — jei sankirtos
  testas atskleis dokumentacijos skolą, tai atskiras task'as.
- `main.ts`/`registry-types.ts` refaktoringas ar registracijų perkėlimas — šis
  task'as tik sprendžia, ar jie priklauso `commandSources`, jų turinio neliečia.
