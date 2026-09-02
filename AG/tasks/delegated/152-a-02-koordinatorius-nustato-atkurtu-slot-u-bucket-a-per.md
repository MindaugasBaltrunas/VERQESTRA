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

## Tikslas
Prieš planavimą integracijos koordinatorius atkurtiems (`restored`) slot'ams kviečia `ports.locateTask` ir perduoda planui task id, kurių bucket'as yra `queue`. Rezultatas: operatoriaus į `queue` grąžintas task'as po loop'o restarto nebeparkuojamas į `human-review` be naujos nesėkmės.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/tests/scheduling-wave-restored-slots.test.ts`

Draudžiama:
- `src/application/scheduling/wave-scheduler.ts`
- `src/application/scheduling/wave-scheduler-state.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/tests/scheduling-pool.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Koordinatoriuje prieš `planWorkerIntegration` surink slot'us su `restored === true`, kiekvienam kviesk esamą `ports.locateTask` ir sudaryk task id sąrašą, kurių bucket'as `queue`; rezultatą perduok planui nauju įėjimo lauku (jį įvedė ankstesnė dalis).
- `locateTask` klaida arba nerastas task'as = bucket'as nežinomas: task id į sąrašą NEPATENKA, elgesys lieka toks pat kaip dabar (fail-closed parkas) — jokio try/catch nutylėjimo be log/detail įrašo.
- Naujame `src/tests/scheduling-wave-restored-slots.test.ts` padenk: atkurtas slot'as + `locateTask` grąžina `queue` → jokio `park`, slot'as pašalinamas iš `finishedSlots` ir task'as vėl dispatch'inamas; `locateTask` grąžina `done`/`human-review` → parkas kaip anksčiau; `locateTask` meta klaidą → parkas kaip anksčiau. Failas ≤ 500 eilučių.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: reikėtų naujo porto ar `wave-scheduler.ts` keitimo; `locateTask` kontraktas neduoda bucket'o be papildomo IO; testui reikėtų realaus failų sistemos priėjimo. Commit'ink tik po žalio `pnpm test`.

## Neįtraukta
`requeue.ts` / `ui-task-actions.ts` snapshot'o valymas — sąmoningai atmesta kryptis (b); `resume-run.ts` `discard-stale` kelias nekeičiamas.
