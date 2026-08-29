## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1 — audito P1 (2026-08-29): escalateOrphanRemoval po 24 h daro `git branch -D` ir gali sunaikinti neintegruotus w2 commit'us, paliekant tik .patch gitignore'intame vq/.

## Tikslas
Pridėti eskalacijos vartą: šaka, kurios commit'ų nėra pagrindinėje šakoje, negali gauti `branch -D` — vietoj to parkuojama operatoriui matomu žurnalo įrašu.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts`
- `src/application/scheduling/wave-snapshot.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `escalateOrphanRemoval` (~:126-176) prieš `git branch -D` (~:164) prideda `git merge-base --is-ancestor <branch> <primaryHead>` patikrą; neigiamas/klaidos kodas reiškia neintegruotus commit'us.
- Tokiu atveju šaka NEtrinama; grąžinamas naujas rezultato statusas (pvz. `parked`), kurį `tryEscalate`/`reapOrphanWorktrees` paverčia atskira, aiškiai matoma žurnalo eilute (pvz. `ORPHAN INTEGRATION PARKED: ...`), o ne tyliu `ORPHAN KEPT`; `.patch` archyvas lieka kaip papildoma kopija.
- Jau integruotos šakos kelias (merge-base OK) lieka nepakitęs — testas turi apimti abu atvejus.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei reikėtų keisti `reapOrphanWorktrees` public kontraktą arba failas viršytų 500 eilučių ribą.

## Neįtraukta
Snapshot ir scheduler pakeitimai (ankstesnės užduotys). Preserved ref'ų retencija (075). Orphan untracked failų valymas (079).
