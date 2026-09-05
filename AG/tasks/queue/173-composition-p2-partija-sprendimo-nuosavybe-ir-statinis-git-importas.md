# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/agent/dispatch-adapters.ts` (173-174) ir `src/composition/loop/coordinator-adapters.ts`
(262) sprendimo nuosavybę tikrina per VIENĄ bendrą domain funkciją (grep `decision-ownership` arba
bendro helper'io vardas abiejuose failuose), o `coordinator-adapters.ts:289` nebeturi
`await import("../../infrastructure/git/git-client.js")` — ALREADY_IMPLEMENTED: cituok tris vietas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 „Loop"; pilna ataskaita
`audit-composition.md` P2-6, P2-9):
- Sprendimo (`vq/supervisor/decision.json`) nuosavybės taisyklė skiriasi pagal skaitytoją:
  `dispatch-adapters.ts:173-174` — case-insensitive, trūkstamas `task_id` = `foreign`;
  `coordinator-adapters.ts:262` — case-sensitive, trūkstamas `task_id` = `ok`. Tas pats failas
  vienam skaitytojui svetimas, kitam savas; pasireiškia su ranka redaguotu/legacy `decision.json`
  (041-a incidentas jau kartą vertė `corrupted` į `foreign`).
- `coordinator-adapters.ts:289` `recordTaskStartStatus` git klientą importuoja dinamiškai
  (`await import(...)`) be ciklo priežasties — tas pats modulis statiškai importuojamas gretimuose
  kompozicijos failuose (`wave-integration-adapters.ts:28`); audito T2 rodo, kad
  `architecture-gates` dinaminių importų nemato, tad tokia forma yra vartų apėjimo šablonas.

Kryptis: viena gryna nuosavybės taisyklė domain sluoksnyje (griežtesnė — dispatch'o — laimi:
kryptis visada griežtinanti), abu adapteriai ją kviečia; importas statinis.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/decision-ownership.ts` (numatomas naujas; jei tinkamesnis `domain/agents` — tas kelias vietoje šio, įrašyti į ataskaitą)
- `src/composition/agent/dispatch-adapters.ts` (165-176)
- `src/composition/loop/coordinator-adapters.ts` (248-266, 288-289)
- `src/tests/domain-decision-ownership.test.ts` (numatomas naujas)
- `src/tests/composition-dispatch-attempt-channel.test.ts` (importuoja `dispatch-adapters`)
- `src/tests/task-execution-run-claude-log.test.ts` (importuoja `coordinatorStatePort`)

Draudžiama:
- `src/composition/loop/coordinator-execution-adapters.ts` (163 scope)
- `src/infrastructure/git/git-client.ts`
- `src/domain/policies/**`
- `src/domain/tasks/allowed-paths.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-ports.ts` (`DispatchDecision` tipas nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujas domain modulis: `decisionOwnership({ decisionTaskId, taskId })` →
  `"own" | "foreign" | "missing"` — case-insensitive po `trim`, tuščias/trūkstamas `task_id` =
  `missing`. Domain be `node:` importų; tik grynos eilučių taisyklės.
- `dispatch-adapters.ts:173-174`: `missing` ir `foreign` → `{ kind: "foreign" }` (kaip dabar),
  bet per bendrą funkciją.
- `coordinator-adapters.ts:262`: `foreign` IR `missing` → `{ status: "invalid", cause: "foreign" }`
  (griežtinimas: legacy sprendimas be `task_id` nebėra „savas"); `cause` neša rastą `task_id`
  arba `"<missing>"`.
- `coordinator-adapters.ts:289`: statinis `import { gitHead, gitStatusPorcelain } from
  "../../infrastructure/git/git-client.js"` failo viršuje; jei `architecture-gates` praneša ciklą —
  stop (žr. Stop).
- Testai: `domain-decision-ownership.test.ts` — raidžių dydis, tarpai, tuščias, `undefined`;
  `composition-dispatch-attempt-channel.test.ts` ir `task-execution-run-claude-log.test.ts` —
  abu adapteriai vienodai atmeta `TASK-1` vs `task-1` nesutapimą ir sprendimą be `task_id`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei statinis `git-client` importas sukuria importų
ciklą (`architecture-gates` raudonas) — tada dinaminis importas turėjo priežastį, ji rašoma į
komentarą, o ne apeinama.

## Neįtraukta
- `DispatchDecision` tipo forma (`dispatch-ports.ts:23`) — nekinta.
- Kiti audito T2 dinaminio importo atvejai už composition ribų (`interfaces` sluoksnyje) — vartų
  autoriaus task'as.
- Benchmark celės aprūpinimas (P2-7) — task 175; quality/bootstrap adapteriai — task 172.
