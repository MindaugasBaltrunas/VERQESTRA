# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/policies/write-policy.ts` `pathBaseName` (arba `evaluateWritePolicy` prieš
`BLOCKED_ENV_FILE_PATTERN`/`BLOCKED_EXTENSIONS` patikrą) nukerpa `[.\s]+$`, o `isMaintenancePath`
faile nebėra (Grep `isMaintenancePath` per `src/**` tuščias) — ALREADY_IMPLEMENTED: cituok kirpimo
eilutę ir `domain-write-policy.test.ts` testą su `.env ` (trailing tarpas).

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, H1 ✓; hooks P1).
`write-policy.ts:193-201`: `pathBaseName` (:86-89) trailing tarpo/taško netrina, tad basename `.env `
neatitinka `BLOCKED_ENV_FILE_PATTERN=/^\.env(\..+)?$/i` (`$` prieš tarpą), o `foo.key ` nesibaigia
`.key` (`endsWith`). Win32 `CreateFile` trailing tarpą/tašką nukerpa → failas nusileidžia kaip `.env`
ar `id_rsa.pem`. Trigeris (dabartinė platforma win32): Write su `file_path: ".env "` arba `".env."`.
Kontrastas: `check-command-allowlist.ts:253-260` `baseExecutable` SĄMONINGAI trina `[.\s]+$` (Windows
`node.` → `node.exe`). `PROTECTED_ORCHESTRATOR`/`PROTECTED_LOGS` naudoja `includes` — jiems junk
nekenkia; apėjimas liečia TIK secret basename/plėtinių taisykles.
Antra to paties failo higiena (hooks P2, „isDistRebuildCommand/isMaintenancePath — N4 mechanizmas
nesuvielintas"): `isMaintenancePath` (:251-255) turi tik testinį kvietėją
(`domain-write-policy.test.ts:115-120`); nei `hookPreWrite`, nei kas kitas jo nekviečia, o realus
stale-dist kelias gyvena loop'e. Trinamas kartu su testu; antra pusė (`isDistRebuildCommand`) — task 205.

## Agentai
readme-guard -> architect -> security -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/domain/policies/write-policy.ts` (`pathBaseName`, plėtinių patikra, `isMaintenancePath` trynimas)
- `src/tests/domain-write-policy.test.ts`

Draudžiama:
- `src/domain/policies/foreign-lease-scope.ts` (importuoja `collapseTraversal`, nekinta)
- `src/domain/policies/bash-command-policy.ts` (task 205)
- `src/domain/policies/check-command-allowlist.ts` (forma kopijuojama, failas nekinta)
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (task 205)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Korpuso patikra (task 157 pamoka): Glob `src/**`, `ui-app/**`, `templates/**`, `AG/tasks/queue/*.md`
  failų vardams su trailing tarpu/tašku — NTFS tokių be `\\?\` prefikso sukurti neleidžia, tad realaus
  korpuso naujas blokas neliečia; rezultatą (0 radinių) įrašyti į ataskaitą.
- `write-policy.ts`: `pathBaseName` grąžina basename be `[.\s]+$` (kaip `baseExecutable`); traversal
  sutraukimas (`normalizeForPolicy`, `escapesRoot`) toliau dirba su ORIGINALIU keliu — `..` segmento
  kirpimas į `""` neturi pakeisti `escapesRoot` verdikto. Plėtinių patikra lygina
  `normalizedFilePath.replace(/[.\s]+$/, "")`. `ALLOWED_ENV_TEMPLATE_BASENAMES` lyginamas jau nukirptas
  basename (`.env.example ` lieka leidžiamas šablonas).
- `mangledWindowsPathBlock` (:157) naudoja tą patį `pathBaseName` — patikrinti, kad suplokštėjusio kelio
  detekcija nepasikeitė (esami testai žali).
- Ištrinti `isMaintenancePath` ir jo N4 komentarą (:246-255) bei testą `:115-120`; `index.ts` naudoja
  `export *`, sąrašo keisti nereikia.
- Testai: `.env `, `.env.`, `.ENV\t`, `id_rsa.pem `, `key.pfx.`, `C:/x/.env ` → BLOCKED (env / plėtinys);
  `.env.example ` → leidžiama; `src/a.ts ` → leidžiama (tarpas pats nėra blokas); `a/..` → escapesRoot
  kelias nepakitęs.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `dead-export-gate.test.ts` `KNOWN_UNCALLED` ar
`FORWARD` sąraše rastum `isMaintenancePath` įrašą (Grep 2026-09-05 jo neranda) — tada tas testas
priklauso scope'ui ir jo eilutė trinama kartu.

## Neįtraukta
- `isDistRebuildCommand` (`bash-command-policy.ts:350`) trynimas — task 205 (tas failas jam priklauso).
- Bash kelio `..` sutraukimas prieš `protectedOrchestratorStateRegex` — task 205.
- Hook'ų fail-open, kai `$CLAUDE_PROJECT_DIR` neišplėstas — Claude Code kontrakto savybė, ne šio kodo.
