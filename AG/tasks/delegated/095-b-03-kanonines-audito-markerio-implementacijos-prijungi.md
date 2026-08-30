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

## Priklausomybės
- 095-auditas-be-radiniu-gali-uzsidaryti-kaip-done-audit-complete
- 095-a-02-audit-complete-markeris-per-diagnosisrulesport-ir

## Tikslas
Prijungti kanoninę domain implementaciją prie `DiagnosisRulesPort` kompozicijos adapteryje, kad audito markerio kelias veiktų gyvame loop'e, o ne tik testų fake'e.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/application/task-execution/verify-task.ts`
- `src/domain/diagnosis/stream-log.ts`
- `src/tests/task-execution-run.test.ts`
- `ui-app`
- `dist`
- `node_modules`

## Veiksmas
- `src/composition/loop/coordinator-execution-adapters.ts` (~200 eil.): greta `hasAlreadyImplementedMarker: (claudeLog) => logHasAlreadyImplementedMarker(claudeLog)` prijunk audito markerio metodą prie kanoninės `domain/diagnosis/stream-log.js` funkcijos (importas 33 eil.).
- `src/tests/composition-cli.test.ts`: patikra, kad realus `taskRunPorts` diagnozės taisyklių port'as atpažįsta `AUDIT_COMPLETE: <santrauka>` tiek žaliame, tiek stream-json log'e — fake'as čia netinka, tikrinamas būtent surišimas.
- Ataskaitoje nurodyk, ar po prijungimo port'o metodas gali tapti privalomu (jei taip — atskiras task'as, čia `run-coordinator-ports.ts` neliesti).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Stabdyk ir klausk, jei prijungimas reikalautų keisti port'o kontraktą (`run-coordinator-ports.ts`) ar domain funkciją, arba jei `composition-cli.test.ts` patikra reikalautų realaus IO. Baigęs su žalia `pnpm test` — commit'ink ir sustok.

## Neįtraukta
- Port'o metodo pavertimas privalomu.
- `verify-task` ir domain logikos keitimai.
