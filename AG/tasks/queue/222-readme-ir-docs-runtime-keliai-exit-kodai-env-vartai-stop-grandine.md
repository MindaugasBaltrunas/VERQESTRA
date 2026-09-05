# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 217-readme-ir-registro-cli-usage-driftas-vartas-lygina-usage
- 218-getting-started-auto-push-teiginys-atitinka-politika

## Žingsnis 0 — ar jau įgyvendinta?
Jei `README.md` exit lentelė mini `69`, runtime lentelė — `vq/supervisor` ir `vq/runtime`,
yra env kintamųjų sąrašas su `AG_UI_PORT`; `docs/architecture.md` Stop grandinė mini
frontend/backend/mobile guard'us ir quality-gates, o vartų lentelė — dead exports ir CSS
coverage; `.claude/rules/workflow.md` neturi `pnpm test:architecture` — ALREADY_IMPLEMENTED:
cituok kiekvieną. Tikrink po punktą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P2 docs (2026-09-05), `audit-docs.md`
20–23, 25–27, 29, 30, 41 — pasenęs arba netikslus tekstas, kiekvienas su kodo įrodymu:
- 20: `README.md:110-113` exit lentelė praleidžia `69` (`EXECUTOR_UNAVAILABLE_EXIT_CODE`,
  `src/shared/exit-codes.ts:22`, `claude-launcher.ts:203-204`).
- 21: `docs/getting-started.md:39-40` „quality-gates … exit 2" — `loadQualityPolicy`
  (`quality-policy.ts:75-76`) meta paprastą `Error` → `main.ts:62` grąžina 1.
- 22: `README.md:117`, `CLAUDE.md:110`, `docs/product-spec.md:98` EV-1 —
  `vq/{state,config,logs,project,architecture,generated}`; kodas kuria ir naudoja
  `vq/supervisor` (`runtime-dirs.ts:19`, `persist.ts:207`) bei `vq/runtime`
  (`infrastructure/runtime-paths.ts:29,194`); `docs/architecture.md:83-92` supervisor mini,
  runtime — ne.
- 23: `README.md:124` `vq/logs/session.md` — joks kodas jo nerašo (vienintelė nuoroda
  `write-policy.ts:61`, saugomas kelias).
- 24: `README.md:187` „port from vq/state/ui-server.json"; realus pirmumas
  (`ui-port-store.ts:4-5`): `AG_UI_PORT` env > `vq/config/commands.env` > `ui-server.json`.
  Nedokumentuoti operatoriaus env: `AG_UI_PORT`, `AG_MAX_WORKERS`
  (`worker-request-store.ts:24`), `AG_PRESERVED_REF_RETENTION_DAYS` (`loop/command.ts:141`,
  14), `AG_EXECUTION_CONTEXT_MODE` (`execution-context-gate.ts:83`),
  `CLAUDE_HEADLESS_TIMEOUT_MS` (`claude-headless.ts:21`), `CLAUDE_DISPATCH_TIMEOUT_MS`
  (`dispatch-timeout.ts:20`), `AG_DISPATCH_STOP_WAIT_MS`/`AG_STOP_BRIDGE_WAIT_MS`
  (`stop-bridge-wait.ts:86-89`), `AG_UI_AUTOSTART` (jau README:197).
- 25: `README.md:108`, `docs/getting-started.md:81` „Stop hook runs the gates and commits";
  `docs/architecture.md:106` grandinė „secret-scan → package-guard → migration-guard →
  commit" praleidžia frontend/backend/mobile guard'us ir `quality-gates`
  (`stop-guards.ts:22-61`).
- 26: `docs/architecture.md:61-69` vartų lentelė be `dead exports` ir `CSS coverage`
  (README:52-53; `dead-export-gate.test.ts`, `dashboard-css-coverage.test.ts`).
- 27: `docs/release.md:83-85` „kiekvienas `files` įrašas tikrinamas" — kodas
  (`release-check-adapters.ts:140`) tikrina fiksuotą `PACKAGE_LAYOUT_PATHS` (4 keliai);
  `ui-app/dist` netikrinamas, CI `build:ui` nepaleidžia.
- 29: `README.md:62` „root package + AG/benchmark + ui-app workspaces" ir `CLAUDE.md`
  „mobile-* node_modules čia nėra" — `pnpm-workspace.yaml:20-22` turi `mobile-gateway`,
  `mobile-app`, `mobile-app/native`.
- 30: `.claude/rules/workflow.md:56` ir `templates/.claude/rules/workflow.md:56`
  `pnpm test:architecture` — skripto `package.json` nėra; `npm run build` maišomas su pnpm.
- 41: `docs/product-spec.md:84` QG-1 „`pnpm test` = lint → build → testai" praleidžia
  `typecheck:ui` → `test:ui` (`package.json:28`, README:55, CLAUDE.md).
Kryptis: dokumentacija taisoma pagal kodą; kur kodas yra spraga (27, `ui-app/dist`
netikrinamas), dokumentas įvardija spragą, ne slepia.

Ribos šio task'o viduje (ne Draudžiama sąrašas, nes failai tie patys): `README.md` „Main
Commands" ir hook lentelės priklauso task'ui 217 — čia jos NEKEIČIAMOS;
`docs/getting-started.md:83-86` auto-push pastraipa priklauso 218 — čia NEKEIČIAMA.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `README.md` (exit lentelė, runtime lentelė, `:62`, `:108`, naujas env skyrius; lentelių
  „Main Commands"/hooks neliesti — 217)
- `CLAUDE.md`
- `docs/architecture.md`
- `docs/release.md`
- `docs/product-spec.md`
- `docs/getting-started.md` (`:39-40`, `:81`; `:83-86` neliesti — 218)
- `.claude/rules/workflow.md`
- `templates/.claude/rules/workflow.md`

Draudžiama:
- `src/**`
- `templates/README.md`
- `pnpm-workspace.yaml`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `README.md`: exit lentelėje pridėti `69` executor unavailable (ir pastabą apie infra
  klasifikuojamus `126/127`); runtime lentelėje pridėti `vq/supervisor` (context pack,
  execution context) ir `vq/runtime` (attempt store); `vq/logs/session.md` pašalinti iš
  sąrašo; `:62` workspace narius papildyti `mobile-*` su pastaba, kad į `pnpm test` jie
  neįtraukti; naujas trumpas skyrius „Environment variables" (operatoriaus env iš Tikslo 24,
  su default'ais ir pirmumu `AG_UI_PORT` > `commands.env` > `ui-server.json`); `:108` Stop
  sakinį papildyti guard'ų sąrašu.
- `CLAUDE.md` „Runtime keliai": pridėti `supervisor`, `runtime`; `mobile-*` sakinį suderinti
  su workspace faktu (nariai yra, bet į `pnpm test` neįtraukti sąmoningai).
- `docs/architecture.md`: runtime lentelėje `vq/runtime`; vartų lentelėje `dead-exports`
  (kiekvienas eksportas turi ne-testinį kvietėją arba KNOWN priežastį) ir `css-coverage`
  (kiekviena TSX className turi taisyklę `view/styles/*.css`); Stop grandinė pagal
  `stop-guards.ts:22-61` tvarką (quality-gates → secret-scan → package → migration →
  frontend → backend → mobile → commit — patikrinti realią tvarką Read'u).
- `docs/release.md:83-85`: „tikrinami fiksuoti paketo formos keliai (`dist/cli.js`,
  `src/cli.ts`, `templates/VERSION`, `templates/.claude/settings.json`); `ui-app/dist`
  netikrinamas ir CI release-check `build:ui` nepaleidžia" — spraga įvardijama.
- `docs/product-spec.md:84` QG-1 pilna grandinė; `:98` EV-1 keliai su `supervisor`, `runtime`.
- `docs/getting-started.md:39-40` „exit 2" → „exit 1 (paprasta klaida, ne usage)"; `:81` Stop
  eilutė — „kokybės vartai → guard'ai (secret, package, migration, frontend/backend/mobile)
  → commit → push (žr. 6 skyriaus pastabą)".
- `.claude/rules/workflow.md:56` ir šablonas: `pnpm build` / `pnpm test` (be
  `test:architecture`, be `npm run`); abu failai lieka identiški.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `src/tests/markdown-readers-real-corpus.test.ts`
ar `docs-retired-names.test.ts` krenta dėl naujo skyriaus struktūros — tada skyrius
perrašomas taip, kad skaitytojai sutartų, o ne testas keičiamas.

## Neįtraukta
- CLI ir hook lentelių eilutės — task 217.
- Auto-push pastraipa — task 218.
- `templates/README.md:3` (`pnpm verqestra install`, `private` paketas, kaip binaras
  atsiranda PATH'e) — audito 36, be numerio šioje partijoje.
- `migration-coverage.json:38` `rules.note` — pin'uoja `migration-coverage-ledger.test.ts`;
  atskiras sprendimas.
- `vq/logs/session.md` rašymo įgyvendinimas kode — ne dokumentacijos task'as.
