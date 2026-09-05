# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei VISI penki: `src/domain/policies/bash-command-policy.ts` `evaluateBashCommandPolicy`
`protectedOrchestratorStateRegex` tikrina ir kelio žetonus po `..` sutraukimo (`cat vq/tasks/../state/x`
blokuojamas); `isGitMutationCommand("git log --grep commit")` → `false`; `isDistRebuildCommand` faile
nebėra; `src/domain/policies/migration-guard.ts` DELETE/WHERE vertina SAKINĮ (per `;`), ne eilutę;
`src/domain/policies/file-classification.ts` `apps/x/node_modules/y/package.json` laiko node_modules
keliu; `src/domain/policies/check-command-allowlist.ts` atmeta `%…%` ir `^` argumentuose —
ALREADY_IMPLEMENTED: cituok penkias vietas. Dalinis įgyvendinimas — tikrinti po punktą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Hooks ir P2 Domain; hooks
ataskaita „protectedOrchestratorStateRegex apeinamas skaitymui per `..`", „isDistRebuildCommand be
runtime kvietėjų"):
- `bash-command-policy.ts:31-32,391-393`: regex reikalauja `(?:AG|vq)[\\/]+state`, o `normalizeCommand`
  (:233) `..` nesutraukia → `cat vq/tasks/../state/task-ledger.json` neturi substring'o, `cat`
  allowlist'intas → orkestratoriaus būsena perskaitoma. `readmeGuardEvidenceRegex` (:33-34) turi
  bare-name alternatyvą, `protectedOrchestratorStateRegex` — ne. Rašymas per bash jau uždarytas
  (`>` blokuoja `shellEscapePattern`); write-policy `collapseTraversal` (:98) rodo teisingą formą.
- `bash-command-policy.ts:366-372` `GIT_MUTATION_PATTERN` `\b(commit|push|…)\b` bet kur po `git` →
  `git log --grep commit` = „mutacija" → reikalauja lease.
- `bash-command-policy.ts:343-355` `isDistRebuildCommand` — N4 mechanizmas, tik testinis kvietėjas
  (`quality-gates.test.ts:192-200`); `hookPreBash` jo nekviečia. Trinamas (antra pusė
  `isMaintenancePath` — task 199).
- `migration-guard.ts:70-74` `DELETE FROM` be `WHERE` tikrinamas PER EILUTĘ: `DELETE FROM t\nWHERE id=1`
  klaidingai BLOCK, `DELETE FROM t; -- WHERE` klaidingai praeina.
- `file-classification.ts:25,40,68,77` `startsWith("node_modules/")` — `apps/x/node_modules/…`
  nepagaunamas: nested `package.json` skaitomas kaip produkto package pakeitimas, lockfile'as — kaip
  svetimas, o secret-scan skenuoja svetimą kodą.
- `check-command-allowlist.ts:47` atmeta `[;&|`$<>\r\n]`, bet NE `%VAR%` ir `^` — Windows'e `.cmd`
  eina per `cmd.exe` (`run-process.ts:155-157`), kur jie plečiami (infrastructure F10).

## Agentai
readme-guard -> architect -> security -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/domain/policies/bash-command-policy.ts`
- `src/domain/policies/migration-guard.ts`
- `src/domain/policies/file-classification.ts`
- `src/domain/policies/check-command-allowlist.ts`
- `src/tests/quality-gates.test.ts` (bash politika, git verbas, `isDistRebuildCommand` testo trynimas, allowlist `%`/`^`)
- `src/tests/domain-migration-guard.test.ts` (numatomas naujas; sakinių lygio testai TIK čia — `interfaces-hooks-package-migration.test.ts` priklauso task 238, jo `:179-199` atvejai lieka žali)
- `src/tests/domain-file-classification.test.ts` (numatomas naujas; nested node_modules atvejai TIK čia — `interfaces-hooks-guards.test.ts` priklauso task 238)

Draudžiama:
- `src/domain/policies/write-policy.ts` (task 199; `collapseTraversal` importuojamas, nekeičiamas)
- `src/tests/bash-policy-loop-entrypoint.test.ts` (`normalizeCommand` NEKEIČIAMAS, kad šis liktų žalias be pakeitimų)
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (task 238; `:52-62` `isGitMutationCommand` atvejai lieka žali)
- `src/tests/interfaces-hooks-package-migration.test.ts` (task 238)
- `src/tests/interfaces-hooks-guards.test.ts` (task 238)
- `src/interfaces/hooks/pre-hooks.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Korpuso patikra (task 157 pamoka) PRIEŠ griežtinimą: Grep `\.\./` per `src/tests/quality-gates.test.ts`,
  `src/tests/bash-policy-loop-entrypoint.test.ts` ir `AG/tasks/queue/*.md` `## Patikra` blokus — komandos
  su `..`, kurios DABAR leidžiamos ir turi likti; Grep `%|\^` per `vq/config/quality-policy.json` ir
  `templates/vq/config/quality-policy.json` `checks` — argumentai, kuriuos naujas atmetimas paliestų.
  Radiniai į ataskaitą; jei tikras korpusas lūžtų — žr. `## Stop`.
- `..` traversal: `normalizeCommand` NELIESTI; naujas `collapseCommandPaths(normalized)` — kiekvienam
  whitespace žetonui su `/` ar `\` pritaikyti `collapseTraversal` (importas iš `write-policy.js`, tas
  pats sluoksnis); `protectedOrchestratorStateRegex` ir `generatedHookRuntimeRegex` tikrinami ir prieš
  sutrauktą formą; `blockedPattern` rodo sutrauktą kelią.
- `GIT_MUTATION_PATTERN` → funkcija: segmento `git` žetonas, praleidžiamos globalios parinktys
  (`-C <p>`, `-c k=v`, `--git-dir=…`, `--work-tree=…`, `--no-pager`), verbas = pirmas likęs žetonas;
  mutacija TIK kai verbas ∈ sąrašui. Grandinės prefiksas (`x && git push`) lieka.
- Ištrinti `distRebuildCommands`/`isDistRebuildCommand` (:343-355) ir testą `quality-gates.test.ts:192-200`
  dalį apie jį (`sensitive` žymės dalis lieka).
- `migration-guard.ts`: turinys skaidomas į sakinius per `;` (ir failo galą), DELETE be WHERE tame pačiame
  sakinyje → BLOCK su DELETE eilutės numeriu; komentarai (`--`, `/* */`) sakinio WHERE nesuteikia.
- `file-classification.ts`: `isInsideNodeModules = /(^|\/)node_modules\//`; naudoti `shouldSkipSecretScan`,
  `isPackageJsonPath`, `isLockfilePath`, `isForeignLockfilePath`.
- `check-command-allowlist.ts`: `%…%` ir `^` argumentuose atmetami ta pačia priežastimi kaip
  `[;&|`$<>]` (cmd.exe plėtimas); komentaras rodo į `run-process.ts` `.cmd` kelią.
- Testai (`quality-gates.test.ts`): `cat vq/tasks/../state/task-ledger.json` → blocked (`vq/state/`),
  `cat vq/tasks/x.md` → ne; `git log --grep commit` / `git -C x log --grep=push` → ne mutacija,
  `git -C x commit -m y` → mutacija (esami `interfaces-hooks-pre-hooks.test.ts:52-62` atvejai lieka žali);
  (`domain-migration-guard.test.ts`) `DELETE FROM t\nWHERE id = 1;` → be bloko, `DELETE FROM t;\n-- WHERE` → BLOCK;
  (`domain-file-classification.test.ts`)
  `apps/x/node_modules/y/package.json` → ne package path, `apps/x/node_modules/y/yarn.lock` → ne lockfile,
  secret-scan skip; `pnpm` args `["run", "build", "%X%"]` → atmesta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei korpuso patikra parodo realią `quality-policy.json`
patikros komandą su `%`/`^` arba `..`, kurią nauja taisyklė sustabdytų — korpusas neperrašomas be
operatoriaus sprendimo.

## Neįtraukta
- `isMaintenancePath` trynimas (`write-policy.ts`) — task 199.
- `sensitivePatterns`/allowlist plėtimas — ne šio task'o tema.
- PreToolUse fail-open, kai dist pasenęs ar `$CLAUDE_PROJECT_DIR` neišplėstas — Claude Code kontraktas.
