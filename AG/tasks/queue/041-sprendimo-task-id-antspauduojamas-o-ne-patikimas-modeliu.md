# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R5")

## Tikslas
`decision.json` `task_id` turi būti sistemos ANTSPAUDUOTAS, o ne perimtas iš modelio išvesties.
Dabar modelis jį įrašo nukirstą ties 50 simbolių, o vartotojas lygina griežta lygybe — todėl
kiekvienas task'as, kurio id ilgesnis nei 50 simbolių, amžinai parkuojamas kaip
`corrupted_decision_json=1`, nors JSON yra visiškai tvarkingas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/application/task-execution/dispatch-task.ts`
- `src/application/task-execution/run-coordinator.ts`
- `src/tests/interfaces-cli-preflight.test.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-slug.ts` (50 simbolių riba slug'ui yra TEISINGA)
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-26, du kartai: 17:12:40 ir 20:17:43): `032-shadow-matuoja-prompta-kuri-worker-realiai-gauna`
  parkuotas `corrupted_decision_json=1` ir antrą kartą sustabdė visą bangą
  (`orchestrator.log:6950,6954`). Failas NEsugadintas — jis parsinasi be klaidų.
- Tikroji priežastis: `vq/supervisor/decision.json` lauke `task_id` guli
  `032-shadow-matuoja-prompta-kuri-worker-realiai-gau` — lygiai 50 simbolių, be galūnės `na`.
  Tikrasis id — 52 simboliai. Vartotojas `composition/loop/coordinator-adapters.ts:243` lygina
  `decision.task_id !== taskId` griežtai, tad nuosavas sprendimas paskelbiamas svetimu.
- Kilmė: sprendimą parašė modelis (`"was_reformulated": true`), ir jis `task_id` nukopijavo iš to
  paties 50 simbolių slug'o, kurį naudojo auto-change katalogo keliui. Riba slug'ui teisinga;
  klaida ta, kad ID FAKTAS imamas iš modelio, nors sistema jį jau žino.
- SPRENDIMO KRYPTIS: `claude-preflight/index.ts:98-103` `writeDecision` yra VIENINTELIS piltuvas,
  per kurį eina kiekvienas sprendimas (jis jau prideda `token_budget_tier` tuo pačiu spread'u).
  Ten `task_id` antspauduojamas iš autoritetingo task id — modelio reikšmė perrašoma, ne
  tikrinama. Nuosavybės vartas `coordinator-adapters.ts:243` NEKEIČIAMAS: jis teisingas, tik
  privalo lyginti su sistemos, o ne modelio įrašytu lauku.
- ANTRA, atskira dalis — priežastis meluoja. `dispatch-task.ts:163` ir `run-coordinator.ts:77`
  abu spausdina `corrupted_decision_json=1`, nors kodo komentaras tame pačiame kelyje jau skiria
  du atvejus („Svetimo task'o sprendimas irgi yra `invalid`"). Svetimas/nesutampantis sprendimas
  turi gauti savo priežastį; operatorius nebeturi būti siunčiamas ieškoti sugadinto JSON, kurio
  nėra. Tai ta pati tiesos taisyklė kaip task 032.
- Testai: (1) preflight su >50 simbolių task id → įrašytame `decision.json` `task_id` sutampa su
  tikruoju; (2) modelio grąžintas nukirstas `task_id` perrašomas, o ne praleidžiamas;
  (3) tikrai svetimo task'o sprendimas ir toliau duoda `invalid`, bet su nauja, atskira priežastimi.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimas imtų reikšti nuosavybės varto silpninimą
(prefiksų lyginimą, `startsWith`, ilgio normalizaciją) — svetimas sprendimas privalo likti
`invalid`, o taisomas yra ID kilmės, ne palyginimo, klausimas.

## Neįtraukta
- `slugFromTask` 50 simbolių riba ir auto-change katalogų kelių forma.
- PASTABA AUTORIUI: task'o tekste `openspec/changes/` prefiksas leidžiamas TIK tikrai, aktyviai
  nuorodai — net citatoje ar backtick'uose preflight'as jį laiko nuoroda. Šis task'as dėl to
  krito 21:42:55 (citata su `…changes/auto-` fragmentu → „does not exist"), o `039` — dėl
  archyvinio kelio 19:28:51. Antrą kartą (05:25:52) jį pargriovė būtent ši pastaba, kol joje
  buvo pilna klaidos citata su prefiksu.
- Retry vartų (`retryGuardAdapters.readDecision`) kelias — jis skaito tą patį failą, bet
  nuosavybės netikrina, tad šio defekto nemato.
- `032` grąžinimas į eilę (operatoriaus veiksmas po pataisos).
