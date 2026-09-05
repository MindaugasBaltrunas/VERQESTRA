# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-refill.ts` `rememberCandidate` (200-206) po aprūpinimo
replan'o gauna ATNAUJINTĄ kandidatą (su `lease`/`worktree_path`), o
`src/application/scheduling/wave-dispatch.ts` (146 apylinkės) antro `beginTask` metimą paverčia
pirmo slot'o atšaukimu (ne paliktu `running`) — ALREADY_IMPLEMENTED: cituok abi vietas ir testus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 „Loop"; pilna ataskaita
`audit-loop-core.md` P2):
- `wave-refill.ts:200-206`: po `provision` replan'o `rememberCandidate` įsimena kandidatą iš
  PRADINIO `candidates` sąrašo (arba sintezuotą be lease), nors laimėtojas po aprūpinimo turi
  naują lease/worktree — vėlesnis `rehydrateLease` tai dengia, bet įsimintas kandidatas lieka
  pasenęs ir kitas skaitytojas gauna melagingą būseną.
- `wave-dispatch.ts:146`: `beginTask` kviečiamas nuosekliai VISIEMS slot'ams prieš bet kurį
  `runTask` — antro slot'o `beginTask` metimas palieka pirmą task'ą `running` (started, lease
  atnaujintas) be jokio vykdymo; edge, bet po jo task'as atrodo gyvas iki lease TTL.

Kryptis: kandidatas įsimenamas PO aprūpinimo iš atnaujintų duomenų; `beginTask` nesėkmė antram
slot'ui atšaukia jau pradėtus (ta pati `dispatchWaveSlots` transakcija) arba `beginTask` daromas
per slot'ą prieš pat jo `runTask`.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-refill.ts` (192-215)
- `src/application/scheduling/wave-dispatch.ts` (`dispatchWaveSlots`, 146 apylinkės)
- `src/tests/scheduling-wave-refill.test.ts`
- `src/tests/scheduling-wave-dispatch.test.ts`

Draudžiama:
- `src/application/scheduling/wave-scheduler.ts` (166 scope)
- `src/application/scheduling/wave-pool-planning.ts` (166 scope)
- `src/application/scheduling/wave-provisioning.ts`
- `src/application/scheduling/slot-task-runner.ts`
- `src/application/scheduling/loop-cycle.ts` (169 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-refill.ts`: `deps.rememberCandidate` kviečiamas su kandidatu, sudarytu iš `decision.slot`
  po aprūpinimo (lease_id, worktree_path, attempt_ref iš laimėtojo), o ne iš pradinio sąrašo;
  sintezuotas fallback'as lieka tik kai laimėtojo `candidates` sąraše nėra.
- `wave-dispatch.ts` `dispatchWaveSlots`: `beginTask` klaida i-tam slot'ui → anksčiau pradėti
  slot'ai grąžinami į neišvykdytą būseną (žurnalas `WAVE DISPATCH ABORTED: slot=… reason=…`,
  jų rezultatas `WaveSlotResult` su `status: "not-started"` ar esamu atitikmeniu) — arba `beginTask`
  perkeliamas prie kiekvieno slot'o `runTask` (pasirinkimą pagrįsti testu; abiem atvejais nė vienas
  task'as nelieka `running` be vykdymo).
- Testai: `scheduling-wave-refill.test.ts` — po aprūpinimo įsimintas kandidatas turi laimėtojo
  lease/worktree; `scheduling-wave-dispatch.test.ts` — antro `beginTask` metimas: pirmas slot'as
  neturi `running` be `runTask`, rezultatuose aiški priežastis.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `beginTask` atšaukimui reikia naujo
`WaveSchedulerContract` metodo (`abortTask`), kurio `wave-scheduler.ts` (166 scope) dar neturi —
tada pasirinkti per-slot `beginTask` variantą be kontrakto keitimo.

## Neįtraukta
- Atkurto slot'o dvigubas dispatch'as ir integracija po crash'o — task 166.
- `slot-task-runner.ts` vaiko env/lease heartbeat — nekinta.
