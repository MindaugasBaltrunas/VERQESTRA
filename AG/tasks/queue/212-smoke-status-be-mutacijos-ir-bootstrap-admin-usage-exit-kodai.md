# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 211-install-be-taikinio-diegia-i-projectroot

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/bootstrap/smoke.ts` ir `src/interfaces/cli/admin/status.ts` NEBEKVIEČIA
`deps.ports.ensureDirs()` (smoke `dir:` eilutės tikrina katalogus PRIEŠ bet kokį kūrimą),
`preflight.ts` su `--json` spausdina `JSON.stringify(decision)`, `restore-stable.ts` nežinomą
argumentą grąžina su exit 2, o `policy.ts` usage grąžina 2 — ALREADY_IMPLEMENTED: cituok
kiekvieną eilutę ir testus `src/tests/interfaces-cli-bootstrap.test.ts`,
`src/tests/interfaces-cli-admin.test.ts`. Dalis punktų gali būti padaryta anksčiau — tikrink
po punktą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C5 ir P2 CLI (2026-09-05),
`audit-cli.md` F6, F9, F13, F22:
- `smoke.ts:72` ir `status.ts:101` kviečia `ensureDirs` → `ensureRuntimeDirs`
  (`runtime-dirs.ts:15-37`) sukuria 12 katalogų ir `retry-counts.json`; po to `smoke.ts:80-107`
  tikrina TUOS PAČIUS katalogus → `FAIL dir:` niekada neįmanomas (tautologija 7/8; tik
  `.claude/agents` realiai tikrinamas). Registras `commands-ops.ts:138` ir `README.md:191`
  žada „nieko nekeičia". Scenarijus: tuščias katalogas be `AG/`, `verqestra smoke` → sukuria
  12 katalogų ir spausdina `OK   dir: AG/tasks/queue`.
- `preflight.ts:33-61` `--json` neapdoroja (README:173, `commands-audit.ts:166` žada JSON).
- `restore-stable.ts:39-42,73-74` nežinomas argumentas → `failed` → exit 1 (turi būti usage 2,
  kaip `install`, `requeue`, kiti).
- `policy.ts:57-58` usage → exit 1; README ir registras rodo `[list|propose ...]`, realios
  subkomandos `show|propose|status`.
Šie failai dalijasi tais pačiais dviem testų failais, todėl vienas task'as.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/bootstrap/smoke.ts`
- `src/interfaces/cli/admin/status.ts`
- `src/interfaces/cli/bootstrap/preflight.ts`
- `src/interfaces/cli/bootstrap/restore-stable.ts`
- `src/interfaces/cli/admin/policy.ts`
- `src/tests/interfaces-cli-bootstrap.test.ts`
- `src/tests/interfaces-cli-admin.test.ts`

Draudžiama:
- `src/composition/cli/commands-ops.ts` (smoke/status portai lieka; `ensureDirs` porto laukas
  gali likti nenaudojamas — tipą siaurinti nereikia)
- `src/composition/runtime/bootstrap-adapters.ts`
- `src/shared/runtime-dirs.ts`
- `src/application/quality-gates/preflight.ts`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `smoke.ts`: ištrinti `await deps.ports.ensureDirs()` (:72); antraštėje (:3) pataisyti
  „išskyrus ensureDirs"; `SmokePorts.ensureDirs` padaryti neprivalomą (`ensureDirs?:`), kad
  composition (`smokePorts`) liktų suderinama be pakeitimo. `dir:` patikros dabar tikrina realią
  būklę: trūkstamas `AG/tasks/queue` → `FAIL dir: AG/tasks/queue` ir `AG_SMOKE_FAILED`.
- `status.ts`: ištrinti `await deps.ports.ensureDirs()` (:101); trūkstamas bucket'as →
  `countMarkdownFiles` grąžina 0 (patikrinti, kad portas neegzistuojančiam katalogui nemeta;
  jei meta — apgaubti `catch → 0` čia, ne porte).
- `preflight.ts`: `args.includes("--json")` → `io.out(JSON.stringify(decision, null, 2))`,
  exit kodas nekinta (`pass` → 0, kitaip 1); `evaluate` gauna `args` be `--json`.
- `restore-stable.ts`: `restoreStableCommand` — `status: "failed"` su `Unknown restore-stable
  option` → `io.error(usage)` ir `return 2`; kiti `failed` (git klaida) lieka 1. Esama
  asercija `:279` (`restoreStable` rezultatas) gali likti; pridėti komandos lygmens exit 2.
- `policy.ts:57-58`: usage → `return 2`; USAGE tekstą palikti `[show|propose|status] [--json]`.
- Testai: smoke — fake `exists` be `AG/tasks/queue` → `FAIL dir:` ir `AG_SMOKE_FAILED`, o
  `ensureDirs` (jei paduotas) NEKVIESTAS; status — `ensureDirs` nekviestas; preflight `--json` →
  valid JSON su `verdict`; restore-stable `["--force"]` → 2; policy `["list"]` → 2.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `countMarkdownFiles`/`listMarkdownFiles`
adapteris neegzistuojančiam katalogui meta ir tai galima ištaisyti tik
`src/composition/runtime/bootstrap-adapters.ts` — tada `status` dalis lieka su `ensureDirs`, o
ataskaitoje įvardijama priežastis.

## Neįtraukta
- Registro/README eilutės (`smoke` „nieko nekeičia" tampa tiesa; `policy` subkomandų sąrašas,
  `preflight --json`) — drift 217.
- `loop-guard`, kuris `ensureDirs` kviečia sąmoningai (paruošia loop'ą) — nekeičiamas.
- `security-verify --json`, `report --recent`, `learning` — task 215.
