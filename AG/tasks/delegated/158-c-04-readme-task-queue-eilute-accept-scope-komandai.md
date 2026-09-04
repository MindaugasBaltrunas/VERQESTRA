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
- 158-b-03-accept-scope-registravimas-cli-registre-compositio

Prielaida iš Dalies 3: `accept-scope` privalo būti registruotas `src/composition/cli/commands-tasks.ts`.
Jei registro įrašo nėra — STOP, nedokumentuok neegzistuojančios komandos.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `README.md` „Task queue" lentelėje jau yra `accept-scope` eilutė — ALREADY_IMPLEMENTED su
citata.

## Tikslas
Dokumentuoti `accept-scope` komandą README „Task queue" lentelėje, kad README ↔ registro auditas
(`readiness-audit`, `src/tests/readiness-command-sources.test.ts`) matytų tą pačią aibę.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `README.md`

Draudžiama:
- `src/composition/cli/commands-tasks.ts`
- `src/interfaces/cli/task-queue/accept-scope.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Įrašyk vieną eilutę po `requeue` „Task queue" lentelėje: komandos vardas, argumentai
  (`<task-file-or-name> <path…>`) ir aprašas — priima trūkstamą kelią į `## Failai` ir perkelia
  task'ą iš `human-review` į `done`.
- Aprašyk, kad šakos merge lieka operatoriui; komanda tik išspausdina merge hint.
- Nekeisk kitų README sekcijų ir lentelės eilučių.

## Patikra
- `pnpm test`

## Stop
Privaloma nurodyta agentų grandinė. Commit'ink, kai patikra žalia. Stop ir klausk, jei lentelės
formatas neleidžia aprašyti variadinio argumento be lentelės struktūros keitimo.

## Neįtraukta
- Bet koks kodo keitimas.
- Politikos pakeitimas „testo failas už ribos → done automatiškai" — operatoriaus sprendimas.
- UI mygtukas `HumanReviewPanel` — atskiras UI task'as.
