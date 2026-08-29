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

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakytas w1/w2 auditas — GeoGravity 1179 klasės (index.lock) taisymo užbaigimas

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `cleanupWorktreeRegistrations` kviečiamas VISUOSE penkiuose worktree
šalinimo keliuose (ne tik eskalacijoje ir provision prieš add) —
ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
Audito P1 radinys (2026-08-29): task 064 registracijų valymą
(`src/infrastructure/git/worktrees/worktree-registration-cleanup.ts:81`)
prijungė tik 2 iš 5 šalinimo kelių. Trys normalūs keliai tebenaudoja pliką
`pruneWorktrees` (`git worktree prune`), kuris pakibusio `index.lock`
negyvoje registracijoje NEVALO — būtent GeoGravity 1179 defekto klasė:

1. `src/infrastructure/git/worktrees/worktree-removal.ts:137`
   (`removeTaskWorktree` — park po integracijos);
2. `src/infrastructure/git/worktrees/worktree-reaper.ts:215`
   (`reapOrphanWorktree` — normalus, ne-eskalacinis reap);
3. `src/infrastructure/git/preserved-work.ts:130` (`dispose`).

GeoGravity, kur worktree politika ĮJUNGTA ir w2 realiai sukasi, šie trys
keliai yra kasdieniai — todėl index.lock zombie'ai ten grįžta po kiekvieno
park/reap, nors 064 formaliai „done".

Taisymas: visuose trijuose keliuose prieš/po `pruneWorktrees` kviesti tą
patį `cleanupWorktreeRegistrations` (kaip 064-a/b keliuose), su tuo pačiu
saugumo kontraktu (valyti tik NEGYVAS registracijas).

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-removal.ts`
- `src/infrastructure/git/worktrees/worktree-reaper.ts`
- `src/infrastructure/git/preserved-work.ts`
- `src/tests/infrastructure-worktrees.test.ts`
- `src/tests/infrastructure-git-preserved-work.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
  (valymo logika teisinga — tik prijungiama)
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: trijuose keliuose prijungti `cleanupWorktreeRegistrations`;
  klaidos valymo metu — best-effort su log eilute, ne šalinimo abortas.
- Tester: kiekvienam keliui atvejis „negyva registracija su index.lock →
  po šalinimo registracijos katalogo nebėra"; gyva svetima registracija
  nepaliesta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Zombie `.git/worktrees/operator-restore-037a` (ne AG namespace — atskiras
operatoriaus rankinis valymas arba 077). Ne-AG namespace registracijų
valymo politika.
