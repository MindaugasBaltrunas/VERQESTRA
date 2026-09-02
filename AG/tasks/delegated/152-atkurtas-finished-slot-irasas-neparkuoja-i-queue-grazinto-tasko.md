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
Iš snapshot'o atkurtas `finished_slots` įrašas nustoja būti „nesėkmė": jis gauna atskirą žymą „baigtis nežinoma", o integracijos planas įgyja šaką, kuri tokį slot'ą su `queue` bucket'o task'u praleidžia vietoje `park reason="task-failed"`. Šioje dalyje įėjimas dar tuščias — elgesys nesikeičia, fail-closed lieka.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-scheduler-state.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/tests/scheduling-pool.test.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts`

Draudžiama:
- `src/application/scheduling/wave-scheduler.ts`
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/interfaces/cli/task-queue/requeue.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-integration.ts`: `FinishedWorkerSlot` gauna `restored?: boolean` (JSDoc: snapshot'o atkurtas įrašas be `write_set`/`lease` — baigtis NEŽINOMA, ne nesėkmė), `WorkerIntegrationSkip.reason` gauna narį `restored-requeued`, o `planWorkerIntegration` įėjimas — sąrašą task id, kurių bucket'as `queue`; abiejose `slot.worktree_path && !slot.succeeded` šakose (inkrementinis ~262, tylos ~322) `restored` + task'as sąraše duoda `skip`, ne `park`, PRIEŠ `task-failed`, bet nekeičiant esamos `infrastructure` pirmenybės.
- `wave-scheduler-state.ts:211-223` `restoreFinishedSlots` rašo `restored: true` šalia `succeeded: false`; komentarą 200-210 papildyk, kad fail-closed lieka (šaka niekada nesuliejama), bet nesėkme nevadinama.
- Testai: `scheduling-pool.test.ts` — nauji atvejai abiem plano šakoms (atkurtas + `queue` → `skip reason=restored-requeued`; atkurtas be `queue` → parkas kaip anksčiau; neatkurtas nesėkmingas → parkas kaip anksčiau); `scheduling-wave-integration-coordinator.test.ts` — TIK esamų `restoreFinishedSlots` lūkesčių (~323-353, ~475-490) pataisa dėl naujos žymos, naujų testų ten nedėti.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: sprendimas reikalautų keisti `wave-scheduler.ts` (500 eil. vartas) ar `resume-run.ts`; reikėtų silpninti esamą testą vietoje kodo taisymo; `PersistedFinishedSlot` schema turėtų keistis. Commit'ink tik po žalio `pnpm test`.

## Neįtraukta
`wave-integration-coordinator.ts` `ports.locateTask` prijungimas ir naujas `src/tests/scheduling-wave-restored-slots.test.ts` — atskira sekanti užduotis, priklausanti nuo šios.
