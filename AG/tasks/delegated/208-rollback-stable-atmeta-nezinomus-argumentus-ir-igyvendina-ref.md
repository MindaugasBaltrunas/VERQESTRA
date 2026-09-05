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

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/bootstrap/rollback-stable.ts` `rollbackStableCommand` (a) nežinomą
argumentą (pvz. `--task-scope`, `--foo`) atmeta su usage eilute į `io.error` ir grąžina `2`
PRIEŠ bet kokį git veiksmą ir (b) `--ref <sha>` skaito per `argValue` ir paduoda kaip taikinį į
`resolveStableTarget` (arba jos atitikmenį) taip, kad `gitCommitExists`, dirty snapshot ir
`detectPushedRollback` vartai bėga prieš NURODYTĄ ref'ą — ALREADY_IMPLEMENTED: cituok usage
šaką ir `--ref` perdavimo eilutę bei atitinkamus testus
`src/tests/interfaces-cli-rollback-stable.test.ts`.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P0-1 (2026-09-05, patikrinta ✓):
`src/interfaces/cli/bootstrap/rollback-stable.ts:412-414` skaito TIK `--allow-task-changes`,
`--task-id`, `--run-id`; nežinomi argumentai neatmetami (`argValue`, :102-105, nežinomo vardo
tiesiog neranda). Registras `src/composition/cli/commands-ops.ts:165` ir `README.md:193` skelbia
`[--task-scope] [--ref <sha>]`. Scenarijus: švarus medis, trys nepush'inti commit'ai,
operatorius paleidžia `verqestra rollback-stable --ref HEAD~1` — `--ref` ignoruojamas,
`allowTaskChanges=false` → `resolveStableTarget` (:240-279) → `runHardReset(<stable-ref>)`
(:380) — medis grąžinamas ne į HEAD~1, o į stable-ref, trys commit'ai prarasti; dirty snapshot ir
pushed-history vartai šio atvejo negaudo, nes medis švarus, o commit'ai lokalūs. Automatinis
kelias (`verify-task.ts:231`, `repair-task.ts:90`) kviečia `--allow-task-changes --task-id` ir yra
sveikas — pažeidžiamas tik žmogus, sekantis README.

Sprendimo kryptis: (1) nežinomas argumentas → usage į stderr, exit 2, jokio git veiksmo;
(2) `--ref <sha>` įgyvendinamas: taikinys = nurodytas ref (turi egzistuoti kaip commit'as), su
TA PAČIA dirty-snapshot ir `detectPushedRollback` apsauga kaip stable-ref keliui; `--ref` kartu
su `--allow-task-changes` — usage klaida (task-scoped kelias taikinį ima iš baseline, ne iš
argumento). Alternatyva „ištrinti `--ref` iš README/registro" atmesta: operatoriui reikia
grąžinti medį į konkretų commit'ą be `restore-stable` viso `reset --hard` į stable-ref.
`--task-scope` NEĮGYVENDINAMAS — jis niekada neturėjo semantikos; po šio task'o jis krenta į
„nežinomas argumentas" ir dingsta iš README/registro drift task'e.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/tests/interfaces-cli-rollback-stable.test.ts`

Draudžiama:
- `src/composition/cli/commands-ops.ts` (usage eilutę keičia README/registro drift task'as)
- `README.md`
- `src/domain/git/rollback-rules.ts`
- `src/composition/runtime/bootstrap-adapters.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `rollback-stable.ts` `rollbackStableCommand`: prieš `ensureDirs`/git veiksmus išparsinti argv
  į žinomą aibę (`--allow-task-changes`, `--task-id <id>`, `--run-id <id>`, `--ref <sha>`);
  bet koks kitas token'as (įskaitant `--task-scope` ir pozicinius) → `io.error("Usage: verqestra
  rollback-stable [--allow-task-changes --task-id <id> [--run-id <id>]] [--ref <sha>]")`,
  `return 2`. Vertės flag'ui trūkumas (`--ref` paskutinis) — ta pati usage klaida.
- `--ref` + `--allow-task-changes` kartu → usage klaida (exit 2) su aiškiu sakiniu, kad
  task-scoped kelias taikinį ima iš baseline.
- `resolveStableTarget` (arba nauja `resolveExplicitRefTarget`) priima pasirinktinį `ref`:
  jei duotas — praleidžiamas `stable-ref` failo skaitymas, bet `gitCommitExists(ref)`
  privalomas (neegzistuojantis → klaida, `ROLLBACK SKIPPED: invalid ref=<ref>`, exit 1);
  toliau IDENTIŠKAI: `nonRuntimeDirtyEntries` → snapshot + blokas, `detectPushedRollback(root,
  ref)` → blokas. `error.log` įraše `target=<ref>` ir `mode=reset`; agLog eilutėje pažymėti, kad
  taikinys iš `--ref`.
- Testai (`interfaces-cli-rollback-stable.test.ts`, esami fake portai): nežinomas argumentas →
  2, `runGit` nekviestas; `--task-scope` → 2; `--ref <sha>` švariame medyje → `runGit(["reset",
  "--hard", "<sha>"])`, ne stable-ref; `--ref` su neegzistuojančiu commit'u → 1 be reset'o;
  `--ref` + dirty medis → blokas su snapshot'u; `--ref` + `detectPushedRollback.blocked` →
  blokas; `--ref --allow-task-changes` → 2; esami `--allow-task-changes` testai nepakitę.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `detectPushedRollback` portas negali
priimti ne-stable ref'o be adapterio pakeitimo `src/composition/runtime/bootstrap-adapters.ts`
(tas failas šiam task'ui uždraustas) — tada `--ref` lieka atmetamas kaip nežinomas, o
įgyvendinimas keliauja į atskirą task'ą su adapterio scope'u.

## Neįtraukta
- Registro usage eilutė (`commands-ops.ts:165`) ir `README.md:193` — README/registro drift
  task'as 217 (priklauso nuo šio).
- `AG_ROLLBACK_CLEAN` skaitymas iš `commands.env` (audito Dk2) — loop autoriaus kodo pusė;
  šablono komentaras — task 221.
- `restore-stable` nežinomo argumento exit kodas (audito F22) — task 212.
