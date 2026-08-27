## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R5")

## Tikslas
Sprendimo atmetimo priežastis meluoja: `dispatch-task.ts` ir `run-coordinator.ts` abu spausdina `corrupted_decision_json=1` net tada, kai JSON tvarkingas, o nesutampa tik `task_id` savininkas. Operatorius siunčiamas ieškoti sugadinto failo, kurio nėra.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/dispatch-task.ts`
- `src/application/task-execution/run-coordinator.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/composition/loop/coordinator-adapters.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Atskirk du atvejus, kuriuos kodo komentaras tame pačiame kelyje jau įvardija: neparsinamas JSON lieka `corrupted_decision_json`, o svetimo/nesutampančio `task_id` sprendimas gauna savo, atskirą priežastį (`dispatch-task.ts` ~163 eil. ir `run-coordinator.ts` ~77 eil.).
- Abu keliai turi naudoti tą pačią priežasčių aibę — jokio dviejų skirtingų pavadinimų tam pačiam atvejui.
- Testas: tikrai svetimo task'o sprendimas ir toliau duoda `invalid`, bet su nauja, atskira priežastimi; sugadintas JSON išlaiko seną priežastį.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Privaloma laikytis nurodytos agentų grandinės. Sustok, jei taisymas reikalautų keisti nuosavybės palyginimą — verdiktas `invalid` nesikeičia, keičiasi tik jo priežastis.

## Neįtraukta
- `task_id` antspaudavimas preflight'e (ankstesnė užduotis).
- Retry vartų `readDecision` kelias — jis nuosavybės netikrina.
