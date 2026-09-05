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
Jei `src/interfaces/cli/bootstrap/install.ts` `installCommand` be pozicinio argumento diegia į
`deps.projectRoot` (laukas `InstallCommandDeps`), o `src/composition/cli/commands-ops.ts`
`install` registracija paduoda `projectRoot: deps.roots.projectRoot` — ALREADY_IMPLEMENTED:
cituok abi eilutes ir testą `src/tests/interfaces-cli-bootstrap.test.ts`.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C4 (2026-09-05), `audit-cli.md` F5,
`audit-docs.md` 1: registras `commands-ops.ts:127` (`usage: "[--dry-run]"`) ir `README.md:190`
dokumentuoja `verqestra install [--dry-run]`, o `install.ts:113-117` reikalauja lygiai vieno
pozicinio (`positional.length !== 1` → `Usage: verqestra install <target-project-dir>
[--dry-run]`, exit 2). Dokumentuota forma be argumento krenta. `deps.roots.projectRoot`
(`CLAUDE_PROJECT_DIR` arba cwd) šiandien neturi jokios įtakos — taikinys tik iš argumento
(`path.resolve` prieš `process.cwd()`); `docs/getting-started.md:43` rašo `install .`, nes
kitaip neveikia.

Sprendimas: be pozicinio taikinys = `deps.projectRoot` (tas pats šaltinis kaip visų kitų
komandų); su vienu poziciniu — kaip iki šiol; du ir daugiau → usage, exit 2. Kryptis
griežtinanti: `install` be argumento tampa deterministiškas pagal `CLAUDE_PROJECT_DIR`, ne pagal
tai, iš kur paleista.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/bootstrap/install.ts`
- `src/composition/cli/commands-ops.ts` (tik `install` registracijos objektas, :125-134)
- `src/tests/interfaces-cli-bootstrap.test.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/composition/runtime/bootstrap-adapters.ts`
- `README.md` (eilutė 190 — drift task'as 217)
- `docs/getting-started.md`
- `templates/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `install.ts`: `InstallCommandDeps` gauna `projectRoot: string`; `installCommand`: 0 pozicinių
  → `target = deps.projectRoot`; 1 → argumentas; ≥2 → usage `Usage: verqestra install
  [<target-project-dir>] [--dry-run]`, exit 2. `installTemplates` ir versijos eilutė gauna
  `path.resolve(target)`.
- `commands-ops.ts` `install` registracija: `projectRoot: deps.roots.projectRoot`; `usage`
  eilutės NEKEISTI (drift task'as 217 keičia visas usage eilutes vienu metu).
- Testai: `interfaces-cli-bootstrap.test.ts` — be argumento rašo į `deps.projectRoot`
  (fake portai fiksuoja kelius), su argumentu — į argumentą, `["a","b"]` → 2 su usage
  (esama :464 asercija `^Usage: verqestra install ` lieka); `composition-cli.test.ts` —
  registro `install` bėga su `roots.projectRoot` (jei ten yra registro smoke per `runCli`,
  pridėti atvejį; jei ne — bent `buildCliCommands` kompiliuojasi su nauju lauku).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `installTemplates` viduje kelias
resolve'inamas dar kartą prieš `process.cwd()` taip, kad `projectRoot` iš `CLAUDE_PROJECT_DIR`
būtų perrašomas — tada reikia `infrastructure` pusės, kuri šiam task'ui uždrausta.

## Neįtraukta
- README `install` eilutė ir registro usage — drift 217 (priklauso nuo šio).
- `docs/getting-started.md:43` `install .` — lieka teisingas ir po pakeitimo; nekeičiama.
- `templates/README.md:3` `pnpm verqestra install <dir>` (paketas `private`) — audito 36,
  neįtraukta į šią partiją.
