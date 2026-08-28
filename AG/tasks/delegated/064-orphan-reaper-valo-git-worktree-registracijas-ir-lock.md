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
openspec/changes/verqestra-backlog-v1

## Tikslas
Sukurti git worktree registracijų valymo primityvą: pašalinti negyvas `.git/worktrees/<name>/` registracijas ir jose likusius pasenusius `index.lock` failus. Šiuo metu `git worktree prune` kviečiamas, bet pakibęs `index.lock` negyvoje registracijoje lieka, ir kiekviena vaiko git operacija atsimuša į `fatal: Unable to create '.git/worktrees/<name>/index.lock': File exists` (GeoGravity 1179, 51 min darbo prarasta).

Ši užduotis tiekia TIK primityvą su testais. Jo kvietimo vietos — atskirose užduotyse.

## Agentai
Privaloma grandinė (šia tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
- `src/tests/infrastructure-worktrees-registration-cleanup.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/infrastructure/git/worktrees/worktree-provision.ts`
- `src/application/**`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- Naujame `worktree-registration-cleanup.ts` eksportuok funkciją, kuri suranda negyvas registracijas (`.git/worktrees/<name>/gitdir` rodo į nebeegzistuojantį katalogą), pašalina jose likusį `index.lock` ir tada paleidžia `git worktree prune`; GYVOS registracijos (katalogas egzistuoja) lock'as neliečiamas.
- Lock'o senumo slenkstį imk iš esamo `src/infrastructure/git/git-automation.ts` sprendimo (`.git/index.lock` valymas pagal amžių) — nekopijuok skaičiaus ranka, o pakartok tą pačią semantiką: šviežias lock'as = gyvas git procesas, jis paliekamas.
- Funkcija NEMETA: nepavykęs valymas grąžinamas kaip rezultato laukas arba žurnalo eilutė, kaip daro `orphan-worktree-reaper.ts`.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok ir klausk, jei reikėtų keisti public kontraktą, trinti esamą eksportą arba silpninti testą.

## Neįtraukta
Reaper'io ir provisioning kvietimo vietos (atskiros nuoseklios užduotys). Gyvų lock'ų arbitražas tarp lygiagrečių vaiko git komandų. Preserved ref'ų valymas (063 scope).
