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
Jei `src/infrastructure/git/git-client.ts` `gitStatus` git nesėkmę skiria nuo tuščio statuso (atskira
`gitStatusResult`/`ok:false` forma), o `integration-branch.ts` `nonRuntimeDirtyPaths` ir
`state/stop-bridge.ts:188` nesėkmę propaguoja kaip NE švarų medį — ALREADY_IMPLEMENTED: cituok tris
vietas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Infrastructure; infrastructure
F5). `git-client.ts:70-74` `result.code === 0 ? stdout : ""` — git klaida (index.lock, EPERM, ne repo)
neatskiriama nuo tuščio statuso. Vartotojai, kurie iš `""` daro SPRENDIMĄ „švarus": `stop-bridge.ts:188`
(`git_status: ""` schema dokumentuoja kaip švarų worktree), `integration-branch.ts:146`
`nonRuntimeDirtyPaths` → `dirty-worktree` vartas (:186-191) IR per jį `worktree-branch-integration.ts:146`
(`dirty-primary-tree` atsisakymas) IR `worktree-provision.ts:49` (`dirty-worktree` karantino priežastis) —
visi tyliai praeina, kai `git status` lūžta. `gitStatusPorcelain` (:76-80) skirtumą turi (`undefined`),
`worktree-reaper.ts:158-171 reapTreeState` apeina savo kopija — trys to paties porto variantai.
Kryptis: `gitStatusResult(root)` → `{ ok: true; status } | { ok: false; detail }`; `gitStatus` lieka
string forma ataskaitiniams vartotojams (`status.ts`, `rollback-stable.ts`, composition adapteriai —
neliečiami) ir realizuojama virš jos; sprendimą darantys vartotojai fail-closed: `nonRuntimeDirtyPaths`
nesėkmę grąžina sentinel įrašu `<git status failed: …>` (namų forma — `rollback-scope.ts:154`
`committedTaskWorkSince`), tad kvietėjai be signatūros keitimo mato NE tuščią sąrašą ir atsisako;
stop bridge rašo `git_status_error` ir tą patį sentinel'į į `git_status`.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/git-client.ts` (`gitStatusResult`, `gitStatus` virš jos)
- `src/infrastructure/git/integration-branch.ts` (`nonRuntimeDirtyPaths` sentinel'is)
- `src/infrastructure/state/stop-bridge.ts` (:57 tipas, :108 įrašas, :188 skaitymas)
- `src/tests/infrastructure-git-client-status.test.ts` (numatomas naujas; `gitStatusResult` ir `nonRuntimeDirtyPaths` ne-repo kataloge)
- `src/tests/infrastructure-state.test.ts` (stop-bridge įrašo forma su `git_status_error`)

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts` (kvietėjas nekinta — sentinel'is jį daro fail-closed)
- `src/infrastructure/git/worktrees/worktree-provision.ts` (tas pats)
- `src/infrastructure/git/worktrees/worktree-reaper.ts` (task 198)
- `src/composition/runtime/bootstrap-adapters.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/infrastructure-worktrees.test.ts` (task 198)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `git-client.ts`: `export async function gitStatusResult(root)`; `gitStatus` = `ok ? status.trimEnd() : ""`
  su JSDoc, kad `""` čia yra ataskaitinė, ne sprendimo forma; `gitStatusPorcelain` nekinta.
- `integration-branch.ts` `nonRuntimeDirtyPaths`: per `gitStatusResult`; `ok:false` → `[`<git status failed: ${detail}>`]`
  (vienas įrašas, neatitinkantis jokio runtime prefikso, tad lieka po filtro); `dirty-worktree`
  vartas (:186-191) tada atsisako su šia priežastimi tekste.
- `stop-bridge.ts`: `git_status_error?: string` įrašo tipe ir schema/rašyme (:57, :108); :188 per
  `gitStatusResult`; nesėkmė → `git_status: "<git status failed: …>"` + `git_status_error: detail` — bet
  kuris skaitytojas, tikrinantis „ne tuščia = nešvaru", tampa fail-closed be savo pakeitimo.
- Testai: ne-git katalogas → `gitStatusResult` `ok:false` su detail; `nonRuntimeDirtyPaths` ten grąžina
  sentinel'į (ne `[]`); repo su sukurtu `.git/index.lock` ir lygiagrečiu `git status`… netestuojamas
  (nedeterministinis) — pakanka ne-repo atvejo; stop-bridge įrašas su `git_status_error` praeina schemą
  ir be jo (senų įrašų suderinamumas).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `stop-bridge.ts` schema yra zod su `strict` ir
egzistuojantys skaitytojai už scope ribų (`coordinator-*`) ją importuoja tipais taip, kad naujas
neprivalomas laukas jų nekompiliuoja — tada laukas dedamas tik į rašymo pusę.

## Neįtraukta
- `worktree-reaper.ts` `reapTreeState` sava kopija — task 198 scope'as (tas failas jam priklauso).
- `git_status` skaitytojų (`coordinator-*`, UI) semantikos keitimas — jie fail-closed per sentinel'į.
- `filterGitIgnored` „klaida = nieko neskipinam" (:63-66) — saugi kryptis, nekeičiama.
