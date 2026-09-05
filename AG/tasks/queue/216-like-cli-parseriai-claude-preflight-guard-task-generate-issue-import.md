# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 211-install-be-taikinio-diegia-i-projectroot

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/cli/commands-ops.ts` `claude-preflight` guard'o `catch` šaka trūkstamam
task failui grąžina 2 (ne 1), `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
priima `--task-id=<id>`, `src/interfaces/cli/task-queue/task-generate.ts` priima `--change=<id>`
ir klaidos tekstas mini `--change`, o `src/interfaces/cli/github/issue-import.ts` rašo į
egzistuojantį bucket'ą (`AG/tasks/queue`) — ALREADY_IMPLEMENTED: cituok eilutes ir testus
`src/tests/composition-cli.test.ts`, `src/tests/interfaces-cli-dispatch-command.test.ts`,
`src/tests/interfaces-cli-task-queue.test.ts`, `src/tests/interfaces-cli-github.test.ts`.
Tikrink po punktą — dalis gali būti padaryta.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P2 CLI ir docs 40 (2026-09-05),
`audit-cli.md` F15, F16, F21:
- `commands-ops.ts:206-215`: `assertFreshCodeIndexForGraphAwareTask` skaito task failą per
  `codeIntelligenceFs.readTextFile` (ENOENT) PRIEŠ handler'io `resolveExistingTaskFile` →
  `catch → return 1`. `verqestra claude-preflight AG/tasks/queue/nera.md` → 1 (task failure),
  o `dispatch`/`diagnose` tam pačiam atvejui → 2 (usage). Taip pat `:223` `io` spread'inamas į
  `claudePreflightPorts`, kurio įvesties tipas `io` neturi — tyliai numetamas.
- `dispatch-invocation.ts:44-45` `--task-id` tik tarpo forma; `--task-id=<id>` ignoruojamas.
- `task-generate.ts:42-66` `--change=<id>` inline → `Unknown flag`, o klaidos tekstas siūlo
  `--openspec`, nors README:145 ir usage sako `--change`.
- `issue-import.ts:125` rašo į `AG/tasks/pending` — bucket'o nėra nei `domain/tasks/buckets.ts`
  sąraše, nei README, nei `templates/AG/tasks/`; sukurtas juodraštis loop'ui nematomas.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/cli/commands-ops.ts` (tik `claude-preflight` registracija, :198-227)
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
- `src/interfaces/cli/task-queue/task-generate.ts`
- `src/interfaces/cli/github/issue-import.ts`
- `src/tests/composition-cli.test.ts`
- `src/tests/interfaces-cli-dispatch-command.test.ts`
- `src/tests/interfaces-cli-task-queue.test.ts`
- `src/tests/interfaces-cli-github.test.ts`

Draudžiama:
- `src/composition/agent/preflight-adapters.ts` (`io` lauko pridėjimas į
  `ClaudePreflightAdapterInput` — kito autoriaus composition/agent scope)
- `src/application/code-intelligence/**`
- `src/interfaces/cli/dispatch/retry-guard.ts` (task 210)
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `commands-ops.ts` `claude-preflight`: prieš guard'ą patikrinti `args[0]` — tuščias arba
  neegzistuojantis failas (per tą patį `codeIntelligenceFs` `exists`/`readTextFile` ENOENT) →
  usage `Usage: verqestra claude-preflight <task-file>` į `(io ?? consoleCliIo).error`,
  `return 2`; kitos guard'o klaidos (pasenęs indeksas) lieka 1. `io` spread'ą į
  `claudePreflightPorts` palikti — jo prijungimas adapteryje yra Neįtraukta.
- `dispatch-invocation.ts`: `--task-id` per `flagValue` iš `../../spec/flag-value.js`; usage
  žinutėje (:34) paminėti `[--task-id <id>]`.
- `task-generate.ts`: `--change=<id>` inline forma; klaidų tekstuose (:63,65) `--change`
  pirmiau, `--openspec` kaip alias.
- `issue-import.ts:125`: `AG/tasks/queue` vietoje `pending` (bucket'as iš `taskBuckets`, ne
  literalas, jei importas iš `domain/tasks/buckets.js` leidžiamas interfaces sluoksniui —
  taip); `task_path` rezultate atitinkamai.
- Testai: `composition-cli.test.ts` — `claude-preflight` su neegzistuojančiu failu → 2 (esamas
  :336 atvejis 0 lieka); `dispatch-command` — `--task-id=0042` ≡ `--task-id 0042`;
  `task-queue` — `parseTaskGenerateOptions(["--change=abc"])`, klaidos tekstas su `--change`;
  `github` — `task_path` prasideda `AG/tasks/queue/`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `issue-import` `pending` bucket'as
yra sąmoningas „juodraščių" kontraktas (Grep `pending` per `docs/`, `AG/openspec`,
`vq/config/github-policy.json` šabloną) — tada vietoje `queue` reikia operatoriaus sprendimo,
ar `pending` įteisinamas `taskBuckets` sąraše.

## Neįtraukta
- `io` prijungimas `claudePreflightPorts`/`claudeDispatchPorts` adapteriuose
  (`src/composition/agent/preflight-adapters.ts:36-41`, `dispatch-adapters.ts:337`) — kito
  autoriaus composition/agent scope; iki tol `stderr` eina tiesiai į `process.stderr`.
- `agRoot` dvi tiesos (`projectRoot+"AG"` vs `deps.roots.agRoot`, audito F20) — atskiras
  refaktoringo sprendimas, ne šios partijos.
- README 145 eilutė (`--change`) — jau teisinga.
