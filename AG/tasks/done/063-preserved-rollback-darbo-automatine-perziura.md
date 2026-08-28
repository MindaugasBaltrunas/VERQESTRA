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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Suteikti infrastruktūrai gebą izoliuotai materializuoti `refs/verqestra/preserved/<sha>` turinį, kad vėliau ant jo būtų galima paleisti task'o patikras. Tik materializavimas — jokio sprendimo, jokio patikrų paleidimo.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/preserved-work.ts`
- `src/infrastructure/git/rollback-scope.ts`
- `src/tests/infrastructure-git-preserved-work.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/application/**`
- `src/composition/**`

## Veiksmas
- Naudok esamą worktree mechanizmą (`src/infrastructure/git/worktrees/worktree-runtime.ts`) ir sukurk funkciją, kuri iš preserved ref padaro detached worktree, grąžina jo kelią, `baseRef`, pakeistų kelių sąrašą ir dispose callback'ą.
- Klaidas grąžink rezultato tipu (ref neegzistuoja / tuščias diff / worktree nepavyko), ne throw; tipai — atskirame `-model` faile, jei atsiranda ciklas.
- Testai: egzistuojantis ref su turiniu → worktree su tais failais; neegzistuojantis ref → klaidos rezultatas; dispose išvalo worktree.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei reikėtų keisti `application` ar `composition` failus arba silpninti guard'ą.

## Neįtraukta
Patikrų paleidimas ant materializuoto turinio, allowlist vertinimas, verify-task sprendimo šaka ir composition surišimas — atskiros nuoseklios užduotys.
