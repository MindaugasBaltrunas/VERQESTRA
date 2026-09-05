# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `templates/.claude/settings.json` `PostToolUse` turi `hook-post-bash-sync` įrašą (be `async`) su
matcher'iu `Bash|PowerShell`, o `PreToolUse`/`PostToolUse` rašymo matcher'iai yra
`Write|Edit|MultiEdit|NotebookEdit`, IR `src/tests/` turi testą, tikrinantį ATVIRKŠTINĘ kryptį
(registro hook ∈ settings; grep `hook-post-bash-sync` per `src/tests/composition-claude-settings*`) —
ALREADY_IMPLEMENTED: cituok įrašus ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 CLI/Hooks; hooks ataskaita
„DEAD/UNWIRED: hook-post-bash-sync registre, bet nė viename settings faile", „Write|Edit matcher
priklauso nuo regex-substring semantikos"):
- `commands-hooks.ts:73` registruoja `hook-post-bash-sync`; `.claude/settings.json:67-76` ir
  `templates/.claude/settings.json:44-53` PostToolUse `Bash|PowerShell` kviečia TIK `hook-post-bash`.
  Sync kelias (`evaluatePostBashSync`/`hookPostBashSync`/`buildPostToolUseHookOutput`,
  `post-hooks.ts:194-250`) — vienintelis, galintis grąžinti `updatedToolOutput` — produkcijoje niekada
  nevykdomas. `composition-claude-settings.test.ts:57-67` tikrina tik forward kryptį (settings ∈ registras),
  `composition-hook-registry.test.ts:33` jį laiko padengtu, nes jis registre. Prijungimas saugus:
  `context-compression.json` vėliavos `false` → hook'as be voko (`interfaces-hooks-post-hooks.test.ts:137`).
- `.claude/settings.json:37,58` / `templates:42,92` matcher `Write|Edit` — `NotebookEdit`/`MultiEdit`
  vartus gauna TIK jei Claude Code matcher'į taiko kaip substring regex. Kodo pusė paruošta
  (`protocol.ts:124` `notebook_path`, `post-write.ts:136`), suvielinimas remiasi neužfiksuota harness
  elgsena; nė vienas testas matcher'io įrankių dengimo netikrina.
Kryptis: pasirinktas PRIJUNGIMAS (ne trynimas — trynimas nusitemptų `post-hooks.ts` sync šaką ir
`domain/tool-results/bash-output-replacement.ts`); matcher'iai eksplicitiniai. SVARBU: `.claude/settings.json`
yra write-policy `PROTECTED_ORCHESTRATOR` (`write-policy.ts:42`) — pre-write hook'as vykdytojo Edit'ą
BLOKUOS; šablono kopija `templates/**` yra carve-out (:227) ir rašoma laisvai.

## Agentai
readme-guard -> architect -> security -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `templates/.claude/settings.json`
- `.claude/settings.json` (hook-saugomas — žr. Veiksmas ir Stop)
- `src/tests/composition-claude-settings-coverage.test.ts` (numatomas naujas; nauji testai rašomi TIK čia — `composition-claude-settings.test.ts` priklauso task 236)

Draudžiama:
- `src/tests/composition-claude-settings.test.ts` (task 236)
- `src/composition/cli/commands-hooks.ts` (registras nekinta — `hook-post-bash-sync` jame jau yra)
- `src/interfaces/hooks/post-hooks.ts`
- `src/tests/composition-hook-registry.test.ts` (ETALON sąrašas nekinta)
- `vq/config/context-compression.json`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `templates/.claude/settings.json`: PostToolUse pridėti `{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "verqestra hook-post-bash-sync" }] }`
  BE `async` (voką Claude Code skaito tik iš sinchroninio hook'o); esamas `hook-post-bash` `async` lieka.
  PreToolUse ir PostToolUse rašymo matcher'iai → `Write|Edit|MultiEdit|NotebookEdit`.
- `.claude/settings.json`: tas pats pakeitimas su `node "$CLAUDE_PROJECT_DIR/dist/cli.js" hook-post-bash-sync`
  forma. Bandyti Edit'ą; tikėtinas `BLOCKED: … saugoma orkestratoriaus busena` — tada tikslų JSON diff'ą
  įrašyti į ataskaitą ir baigti pagal `## Stop`. Vartų apėjimas (bash `>`, kitas kelias) DRAUDŽIAMAS.
- `composition-claude-settings-coverage.test.ts` (naujas; forma kaip `composition-claude-settings.test.ts`
  — `buildCliCommands` + `readSettings`): (1) atvirkštinė kryptis — kiekvienas registro `hook-*`, išskyrus
  Stop fan-out/guard'ų aibę (`hook-secret-scan`, `hook-package-guard`, `hook-migration-guard`,
  `hook-backend-guard`, `hook-frontend-guard`, `hook-mobile-guard`, `hook-session-summary` — kviečiami iš
  `hook-on-stop`/`hook-post-write`, ne iš settings), privalo būti `templates/.claude/settings.json`;
  (2) įrankių dengimas — PreToolUse ir PostToolUse turi įrašą, kurio matcher'is pilnai (`^(?:m)$`) atitinka
  kiekvieną iš `Write`, `Edit`, `MultiEdit`, `NotebookEdit` (šaltinis: `claude-tool-schema.ts:169`
  `DISPATCH_WRITE_TOOLS`); (3) `hook-post-bash-sync` įrašas templates faile be `async`. Testai (1)–(3)
  rašomi TIK `templates/.claude/settings.json` failui; `.claude/settings.json` paritetas — Neįtraukta,
  kol operatorius jo nepritaikė (kitaip vartas raudonas be galimybės ištaisyti).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios (templates + testai). `.claude/settings.json` Edit'ą pre-write hook'as
blokuoja — po žalio commit'o STOP ir pateik operatoriui tikslų diff'ą pritaikyti ranka; to nedaryk jokiu
apėjimo keliu.

## Neįtraukta
- `.claude/settings.json` ↔ `templates` pariteto testas — po operatoriaus pritaikymo, atskiras task'as.
- `context-compression.json` vėliavų įjungimas (Bash išvesties perrašymas realiai) — politikos sprendimas.
- `mcp__*` matcher'iai — dispatch kelyje MCP serverių nėra (hooks ataskaita), P2 be trigerio.
