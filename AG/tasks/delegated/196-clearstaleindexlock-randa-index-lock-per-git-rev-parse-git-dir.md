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
Jei `src/infrastructure/git/git-automation.ts` `clearStaleIndexLock` lock'o kelią išsprendžia per
`git rev-parse --absolute-git-dir` (arba `--git-dir` + `path.resolve` nuo `projectRoot`), o ne per
`path.join(projectRoot, ".git", "index.lock")`, IR yra testas su `git worktree add` sukurta kopija —
ALREADY_IMPLEMENTED: cituok rev-parse kvietimą ir testo pavadinimą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, I1 ✓; pilna ataskaita —
infrastructure F1): `git-automation.ts:43` `path.join(projectRoot, ".git", "index.lock")`. Linked
worktree'e (`.ag/worktrees/<run>/<w>-<task>-a<n>`) `.git` yra FAILAS (gitdir rodyklė), o tikras lock'as
gyvena `<main>/.git/worktrees/<name>/index.lock`. Stop hook'as w2+ slot'e bėga su
`CLAUDE_PROJECT_DIR=worktreeAbs` (`composition/loop/command.ts:276`), tad `existsSync(lockPath)` ten
VISADA `false`, `addAndCommit` retry šakos (`git-automation.ts:115,122`) nepasiekiamos, ir nužudyto
`git add` paliktas lock'as kiekvieną tolesnį commit'ą verčia į `index.lock` klaidą → task'as parkuojasi
human-review. `worktree-registration-cleanup.ts` lock'ą valo TIK negyvoms registracijoms
(`isDeadRegistration`), gyvai kopijai nepadeda. Repo jau turi teisingą formą:
`worktrees/worktree-owner.ts:21` `worktreeGitDir` → `rev-parse --absolute-git-dir`. Kryptis: tas pats
rezoliucijos būdas `clearStaleIndexLock` viduje; git nesėkmė → `false` (nieko netrinama, fail-closed).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/git-automation.ts` (`clearStaleIndexLock`, `addAndCommit` await'ai)
- `src/tests/infrastructure-git-automation.test.ts` (numatomas naujas; testai rašomi TIK čia — `infrastructure-git.test.ts` priklauso 197/201 scope'ams)

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-owner.ts` (`worktreeGitDir` importuojamas arba kopijuojamas kaip forma, nekeičiamas)
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
- `src/composition/hooks/stop-adapters.ts` (kvietėjas `commitAndPush(input.projectRoot, …)` nekinta)
- `src/tests/infrastructure-git.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `git-automation.ts`: `clearStaleIndexLock(projectRoot, runner = run)` tampa `async`; git admin katalogas
  = `runner("git", ["-C", projectRoot, "rev-parse", "--absolute-git-dir"])` → `path.normalize(stdout.trim())`;
  `code !== 0` arba tuščias stdout → `false`. Lock kelias = `path.join(gitDir, "index.lock")`; amžiaus
  riba `STALE_INDEX_LOCK_MS` ir `rmSync` lieka kaip yra.
- `addAndCommit` (115, 122): `await clearStaleIndexLock(projectRoot, runner)` — tas pats injektuotas
  `runner`, kad testų fake'ai kontroliuotų ir rev-parse atsakymą. Esamų `infrastructure-git.test.ts`
  `commitAndPush` fake'ų neliesti: jei fake'as į `rev-parse` neatsako arba grąžina `code !== 0`, rezultatas
  yra `false` ir elgesys sutampa su dabartiniu (lock'as nevalomas) — jie lieka žali be pakeitimų.
- `commitAndPush`/`pushBranch`/`pushPrimaryBranch` signatūros NEKINTA.
- Testai (`infrastructure-git-automation.test.ts`, realus git tmp kataloge, kaip
  `infrastructure-worktrees-merge-contention.test.ts`): (1) pagrindiniame repo pasenęs
  (`utimes` > 5 s) `.git/index.lock` pašalinamas ir `commitAndPush` retry pavyksta; šviežias — paliekamas,
  commit'as grąžina `ok:false step:"add"|"commit"`; (2) `git worktree add` kopijoje lock'as
  `<main>/.git/worktrees/<name>/index.lock` (pasenęs) pašalinamas ir commit'as kopijoje pavyksta — tai
  incidento reprodukcija; (3) ne-git katalogas → `false`, jokio `rmSync`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `--absolute-git-dir` nepalaikomas repo naudojamoje git
versijoje (< 2.13) — tada `--git-dir` + `path.resolve(projectRoot, …)`; sprendimą įrašyti į ataskaitą.

## Neįtraukta
- Negyvų registracijų lock'ų valymas (`worktree-registration-cleanup.ts`) — jau veikia, nekeičiamas.
- Stop hook'o `projectRoot` semantika w2+ slot'e (`command.ts:276`) — loop komanda, ne šio task'o scope.
- `gitStatus` nesėkmės tyla (F5) — task 201.
