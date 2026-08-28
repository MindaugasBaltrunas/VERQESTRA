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

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu — w2 slot'o bėgimai nematomi dashboard'e; rankinis skėlimas po preflight oversized: čia SERVERIO/projekcijos dalis, UI dalis — 065-b

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-waves-view` (arba dashboard view) atsakymas jau neša ABIEJŲ slot'ų
(w1 ir w2) būseną: task id, fazę, worktree kelią, bėgimo pradžią/trukmę ir
paskutinę w2 baigtį (`merged` / `parked:<priežastis>` / `child exit <kodas>`)
— ALREADY_IMPLEMENTED su konkrečiomis eilutėmis.

## Tikslas
SERVERIO pusė w2 matomumui (UI blokus daro 065-b, priklausantis nuo šio).
2026-08-28 patirtis: w2 slot'ai realiai dirbo (iki 51 min sesijos), bet
dashboard'as jų nerodė — operatorius diagnozavo grep'indamas
orchestrator.log. Duomenys backend'e JAU yra: worker lease store,
`wave-slot-model.ts` (vieno slot'o būsena bangoje), wave snapshot,
wave-events.jsonl.

Šio task'o darbas: užtikrinti, kad ui HTTP sluoksnis servuoja pilną abiejų
slot'ų vaizdą — kiekvienam slot'ui: worker id, task id, fazė
(bootstrap/preflight/delegated/integracija), worktree kelias, pradžios
laikas; plius paskutinės w2 baigties įrašas iš wave-events. Tik projekcija
iš esamų šaltinių — jokio naujo log parsinimo, jokios verslo logikos.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/ui-model/wave-slot-model.ts`
- `src/interfaces/http/ui-waves-view.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/tests/interfaces-http-waves-view.test.ts`
- `src/tests/interfaces-ui-model-wave-slot.test.ts` (numatomas; jei testas
  gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/scheduling/**` (planavimo logika nesikeičia)
- `ui-app/**` (UI dalis — 065-b)
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
UI komponentai, i18n, dashboard blokai (065-b). Scheduling/provisioning
elgsena. Istorinių bangų archyvas. Mobile gateway. Nauji log formatai.

## Veiksmas
- Įgyvendink `## Tikslas` sekcijoje aprašytą pakeitimą.
