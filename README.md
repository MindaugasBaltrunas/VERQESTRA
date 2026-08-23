# VERQESTRA

Spec-first orchestration framework for bounded AI coding agents — the canonical
rebuild of AG Loop. Every module arrives optimized into the target architecture;
there is no legacy class and no baseline exemption by construction.

Migration source of truth: `D:\React\AG_loop` (read-only behavioural etalon) —
see `AG/openspec/changes/ag-loop-v2-7-architecture-upgrade` there for the plan
(E0–E8), the frozen baseline (VQ-001) and the characterization fixtures the code
in this repository must satisfy verbatim (PAR-1).

## Layout

```text
src/
├── shared/          # primitives: result, errors, ids, json, markdown, hash, paths
├── domain/          # pure rules — no filesystem, no process, no clock
├── application/     # use-cases + ports; IO only through injected ports
├── infrastructure/  # adapters implementing application ports
├── interfaces/      # delivery: cli, hooks, http, ui-model
├── composition/     # manual DI wiring; nothing imports composition
│   ├── cli/         #   command registry + command groups
│   ├── hooks/       #   Claude Code hook wiring
│   ├── ui/          #   operator UI server, router, SSE
│   ├── loop/        #   wave scheduler, coordinator, integration
│   ├── quality/     #   quality gates, audit, diagnose, readiness
│   ├── agent/       #   agent dispatch + preflight
│   └── runtime/     #   package roots, Node adapters, bootstrap
├── tests/           # node --test suites + characterization fixtures
└── cli.ts           # the only entrypoint
```

## Gates — fail-closed from the first commit

| Gate | Rule |
|---|---|
| file-length | every source file ≤ 500 lines, NO baseline |
| boundary | layer import direction (see `src/tests/architecture-gates.test.ts`), zero exceptions |
| classification | every `src/**` file must belong to a known layer/role |
| cycles | module import graph must be acyclic |
| strict TS | `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` in the BASE tsconfig |

`pnpm test` runs the gates with the unit suite; a violation fails the build.

## Getting started

```bash
pnpm install          # šaknies paketas + AG/benchmark + ui-app darbo sritys
pnpm typecheck        # tik tipai, be emit
pnpm test             # lint -> build -> testai (vartai bega pirmi)
pnpm build            # dist/ + .buildstamp
pnpm build:ui         # dashboard'as i ui-app/dist
node dist/cli.js help # visos komandos
```

Platesnis kelias — [`docs/getting-started.md`](docs/getting-started.md).
Architektūra ir jos priežastys — [`docs/architecture.md`](docs/architecture.md).
Auditų ataskaitos — [`docs/audits/`](docs/audits/README.md).

## Main Commands

Visos komandos yra viename registre (`src/composition/cli/registry.ts`), ir CLI pagalbos
ekranas spausdina ta pati sarasa ta pacia tvarka. Sarasas cia ir registras yra tikrinami vienas pries
kita: `verqestra readiness-audit` krinta, jei komanda egzistuoja, bet nera dokumentuota.

### Spec ir planas

| Komanda | Ką daro |
|---|---|
| `verqestra export-json-schema [--out <dir>]` | Eksportuoja politikų JSON schemas į katalogą |
| `verqestra export-api-contract [--out <file>]` | Eksportuoja aktyvaus spec pakeitimo API kontraktą |
| `verqestra learning <list|approve|reject> [id]` | Learning atminties įrašai ir rekomendacijų sprendimai |
| `verqestra plan [--force]` | Sukuria architektūros kontraktą iš aktyvios spec'ifikacijos |
| `verqestra task-generate [--change <id>] [--start <n>]` | Generuoja eilės užduotis iš spec plano |
| `verqestra spec-drift <change-id>` | Lygina pakeistus failus su spec change scope |
| `verqestra openspec-reconcile [--apply]` | Sutikrina OpenSpec pakeitimus su užduočių būsena |

### Užduočių eilė

| Komanda | Ką daro |
|---|---|
| `verqestra task-ledger-sync` | Sutikrina task ledger'į su realiais bucket'ų failais |
| `verqestra task-move <task-file> <target-dir>` | Perkelia užduoties failą į kitą bucket'ą |
| `verqestra requeue <task-file-or-name>` | Grąžina užduotį į eilę (ledger + biudžeto atstatymas) |
| `verqestra status` | Eilės, einamojo task'o, tokenų ir stop įrodymo santrauka |
| `verqestra process-queued-task <task-file>` | Vieno eilės task'o pilnas ciklas (loop child vykdytojas) |
| `verqestra task-dependencies [list|route-blocked <task-id>] [--json]` | Užduočių priklausomybės ir blokuotų užduočių maršrutizavimas |

### Auditas, vartai ir politikos

| Komanda | Ką daro |
|---|---|
| `verqestra backlog-audit [--json]` | Eilės backlog'o auditas (dublikatai, superseded, tuščios užduotys) |
| `verqestra security-verify [--json]` | Saugumo politikos patikra pakeistiems failams |
| `verqestra release-notes [--json]` | Generuoja release notes iš ledger'io ir būsenos |
| `verqestra quality-gates [scope] [--json] [--no-memo]` | Sukonfigūruoti lint/typecheck/test/build vartai su statusu ir log'u |
| `verqestra converge` | Sutikrina spec planus su eilės failais |
| `verqestra readiness-audit [--json]` | Produkto pasirengimo auditas (aplankai, konfigai, komandos, testai, docs) |
| `verqestra audit-director` | Kokybės patikros ciklu su taisančiu agentu (iki 3 iteracijų) |
| `verqestra final-audit [--json]` | Galutinis išleidimo verdiktas iš visų vartų ir įrodymo artefaktų |
| `verqestra preflight <task-file> [--json]` | Vartai prieš dispatch'ą: dydis, spec šaltiniai, biudžetas, agentai |
| `verqestra policy [list|propose ...]` | Politikų peržiūra ir pasiūlymų žurnalas |
| `verqestra agent [list|add|remove ...]` | Agentų personų registras |
| `verqestra project-status` | Projekto būsenos dokumentas iš spec, eilės ir release įrodymo |
| `verqestra report [--json] [--recent <n>]` | Vietinė telemetrijos ataskaita (užduotys, tokenai, kompresija, adapteriai) |
| `verqestra build-gate` | Ar sugeneruotas dist atitinka src (hook'ai ir loop vykdo dist) |
| `verqestra milestone-check` | Milestone vartai: kokybė, spec derėjimas, saugumo politika |
| `verqestra release-check` | Išleidimo vartai: build, testai, milestone, dokumentai, paketo forma |

### Projektas ir vykdymas

| Komanda | Ką daro |
|---|---|
| `verqestra project-mode [--json]` | Nustato projekto režimą (naujas, tęsiamas, nutrūkęs) |
| `verqestra ui` | Paleidžia dashboard'ą ant 127.0.0.1 (prievadas — iš vq/state/ui-server.json) |
| `verqestra bootstrap-project [--json]` | Paruošia architektūros grafą ir pirmąsias eilės užduotis iš README |
| `verqestra compound-init <aprašymas> [--force]` | Paruošia darbo erdvę ir projekto profilį |
| `verqestra install [--dry-run]` | Įdiegia šablonus į projektą (esamų failų neperrašo) |
| `verqestra smoke` | Aplinkos ir eilės smoke patikra (nieko nekeičia) |
| `verqestra restore-stable [--execute]` | Atkuria medį iš stable-ref (be --execute tik parodo planą) |
| `verqestra rollback-stable [--task-scope] [--ref <sha>]` | Grąžina medį į stable-ref su untracked snapshot'u |
| `verqestra claude-dispatch <task-file> [--task-id <id>]` | Paleidžia vykdytojo modelį su maršrutu, biudžetu ir stop-bridge įrodymu |
| `verqestra claude-preflight <task-file>` | LLM preflight: performulavimas, spec kontekstas, agentai, biudžetas |
| `verqestra claude-diagnose <task-file>` | Diagnozuoja nepavykusį bandymą ir parašo repair sprendimą |
| `verqestra loop` | Eilės vykdymo ciklas: bangos, slot'ai ir integracija iki tuščios eilės |
| `verqestra loop-guard` | Pre-loop patikros be loop'o starto (0 = saugu, 1 = blokuota) |
| `verqestra dispatch <task-file> [--adapter <kind>]` | Paleidžia vykdymo adapterį PO preflight, biudžeto ir context-pack vartų |
| `verqestra codex-dispatch <task-id> [--adapter codex]` | Codex adapterio kelias (be --adapter codex — dry-run) |
| `verqestra retry-guard [--task-id <id>]` | Retry skaitikliai ir limitas prieš human-review nusileidimą |
| `verqestra on-stop-bridge <status> [reason]` | Įrašo Stop-bridge įrodymą (attempt + globalus veidrodis) |

### Kodo žvalgyba ir architektūra

| Komanda | Ką daro |
|---|---|
| `verqestra code-index [build|check|architecture-check]` | Kodo indeksas (skenas, simboliai, sviezumas) |
| `verqestra code-graph query <file-or-symbol> [--json] [--fuzzy]` | Kodo grafo uzklausos (priklausomybes, simboliai) |
| `verqestra context-pack <task-file> [--with-code-graph]` | Surenka konteksto paketą užduočiai (retrieval, biudžetas, kešas) |
| `verqestra architecture [init|check|import-mmd|next-node|synthesize-node|verify-node|run-tree|code-map]` | Architekturos grafas, banga, verifikacija ir kodo zemelapis |

### Benchmark ir integracijos

| Komanda | Ką daro |
|---|---|
| `verqestra benchmark [--mode <režimas>] [--json]` | Paleidžia @verqestra/benchmark paketą |
| `verqestra benchmark-drive --workdir <d> --model <m> --step-limit <n> --timeout-ms <n> [--prompt-file <f>]` | Vienas ribotas headless agento bėgimas benchmark scenarijui |
| `verqestra benchmark-loop-cell --workdir <d> --model <m> --step-limit <n> --timeout-ms <n> --allowed-paths <a|b> [--checks <a|b>]` | Viena ag-loop benchmark celė: pilnas eilės ciklas scenarijaus kopijoje |
| `verqestra optimization-benchmark [--capture|--compare] [--json]` | Optimizacijos matavimas prieš baseline |
| `verqestra github-issue-import --issue <numeris>` | Importuoja GitHub issue kaip užduoties juodraštį |
| `verqestra github-pr [--create]` | Sudaro PR tekstą iš vartų būsenos (be --create tik juodraštis) |

### Claude Code gyvavimo ciklo hook'ai

Jie kviečiami NE ranka, o per `.claude/settings.json` (žr. `templates/.claude/settings.json`).

| Komanda | Ką daro |
|---|---|
| `verqestra hook-pre-bash` | PreToolUse: bash komandų politika, git mutacijų nuosavybė (BLOKUOJA) |
| `verqestra hook-pre-write` | PreToolUse: rašymo politika, readme guard'as, runtime nuosavybė (BLOKUOJA) |
| `verqestra hook-post-bash` | PostToolUse: Bash žurnalas ir digest shadow telemetrija |
| `verqestra hook-post-bash-sync` | PostToolUse: sinchroninis Bash išvesties digest kelias |
| `verqestra hook-post-read` | PostToolUse: readme skaitymo įrodymas |
| `verqestra hook-post-write` | PostToolUse: sesijos rašymų ledger'is, KPI įvykiai ir guard'ų fan-out |
| `verqestra hook-secret-scan` | Guard: kredencialų skenavimas pakeistuose failuose (radinys → exit 1) |
| `verqestra hook-package-guard` | Guard: package.json ir lockfile pakeitimų pagrindimas |
| `verqestra hook-migration-guard` | Guard: DB migracijų pakeitimai ir destruktyvus SQL |
| `verqestra hook-backend-guard` | Guard: Express backend saugumo taisyklės |
| `verqestra hook-frontend-guard [post|stop]` | Guard: frontend komponentų taisyklės (stop režimu ir lint) |
| `verqestra hook-mobile-guard [post|stop]` | Guard: mobile aplikacijos taisyklės (stop režimu ir typecheck) |
| `verqestra hook-session-start` | SessionStart: įrodymų reset'as su trimis stabdžiais ir git baseline |
| `verqestra hook-session-end` | SessionEnd: sesijos apimtis ir runtime įrašo atlaisvinimas |
| `verqestra hook-session-summary` | Sesijos santrauka: patikros, pakeisti failai, guard'ų būsena |
| `verqestra hook-user-prompt` | UserPromptSubmit: vienkartinis orkestratoriaus konteksto blokas |
| `verqestra hook-on-stop` | Stop: vartai, commit ir push darbo eiga sesijos pabaigoje |


## Migration coverage

`migration-coverage.json` tracks every live AG_loop module
(`pending | migrated | wont-migrate(reason)`). Cutover (E8) requires 0 `pending`.
The file moves to `vq/state/` when the repo becomes self-hosting (E7).
