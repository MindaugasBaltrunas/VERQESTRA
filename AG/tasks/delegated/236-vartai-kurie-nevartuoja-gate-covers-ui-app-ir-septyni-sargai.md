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
Jei `src/tests/gate-covers-ui-app.test.ts` skaito `ui-app/package.json#scripts.test` (privalo prasidėti
`vitest run`, be `--passWithNoTests`/`--dir`) ir `ui-app/vitest.config.ts` (`include` nesiaurina
`src/tests/**`), o `gate-install-covers-smoke.test.ts` sąrašą laiko SAVO literalu — ALREADY_IMPLEMENTED:
cituok abiejų testų asercijas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, T3 ir „Testai" P2;
`scratchpad/audit-tests.md` §4): (T3) `gate-covers-ui-app.test.ts:28-57` tikrina tik šaknies
`package.json` eilutes — `ui-app/package.json` `"test": "vitest run --passWithNoTests --dir nonexistent"`
būtų žalia (incidentas 2026-08-26 grįžtų). Septyni sargai, kurie nesaugo: `gate-install-covers-smoke:20-23`
sąrašą importuoja iš testuojamo `smoke.ts` (išbraukus `config/models.env` — abu žali), `:91` regex leidžia
`FOO=`; `migration-coverage-ledger:94-164` „įrodymas" = `length >= 40`, `direction` regex be `\b`
(`negriežtinantis` praeina); `readiness-command-sources:58-74` sankirta `> 0` vartui, gimusiam iš „4 iš
53"; `docs-retired-names:21,53` `retired-name-ok` žymė galioja ir kodo eilutei; `composition-claude-settings:44,63-66`
tik viena kryptis (registro `hook-*` be settings įrašo nepagaunamas), `REQUIRED_EVENTS` tik `length > 0`;
`dashboard-css-coverage:104-116` tuščia taisyklė `.x {}` ar `:not(.x)` = padengta; `i18n-coverage:24,103`
mato tik `t("…")` (`t('…')`, `t(\`…\`)`, `t("…", arg)` nepatenka), antras testas `unused < translated/2`
neriboja. Korpusas 2026-09-05: `ui-app/package.json` `"test": "vitest run"`, `vitest.config.ts` be
`include`; tuščių CSS taisyklių ir `t('…')` formų — 0; žymė tik `wave-graph.ts:98` komentare;
`hook-post-bash-sync` registruotas, bet niekur nekviečiamas (žinoma išimtis atvirkštinei krypčiai).

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/gate-covers-ui-app.test.ts`
- `src/tests/gate-install-covers-smoke.test.ts`
- `src/tests/migration-coverage-ledger.test.ts`
- `src/tests/readiness-command-sources.test.ts`
- `src/tests/docs-retired-names.test.ts`
- `src/tests/composition-claude-settings.test.ts`
- `ui-app/src/tests/gates/dashboard-css-coverage.test.ts`
- `ui-app/src/tests/gates/i18n-coverage.test.ts`

Draudžiama:
- `ui-app/package.json`, `ui-app/vitest.config.ts` (korpusas jau tenkina — nekeičiami)
- `src/interfaces/cli/bootstrap/smoke.ts` (sąrašas dubliuojamas teste sąmoningai, šaltinis nekinta)
- `migration-coverage.json`, `.claude/settings.json`, `templates/**` (korpusai — taisyklės kalibruojamos taip, kad jie liktų žali)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `gate-covers-ui-app`: skaityti `ui-app/package.json#scripts.test` (`/^vitest run(\s|$)/`, draudžiami
  `--passWithNoTests`, `--dir`, `|| true`) ir `vitest.config.ts` (jei `include` yra — privalo dengti `src/tests/**`).
- `gate-install-covers-smoke`: savas literalus sąrašas (`config/commands.env`, `config/models.env`)
  lyginamas `deepEqual` su `SMOKE_REQUIRED_RUNTIME_FILES`; `FOO=` (tuščia reikšmė) — raudona.
- `migration-coverage-ledger`/`readiness-command-sources`/`docs-retired-names`/`composition-claude-settings`:
  `direction` su `\b`, įrodymas privalo minėti kelią ar testo vardą; sankirta lyginama su registro
  aibe (lygybė, ne `> 0`); žymė galioja TIK komentaro eilutėje; atvirkštinė kryptis su aiškiu išimčių
  sąrašu (`hook-post-bash-sync` — audito P2), `REQUIRED_EVENTS` = konkretus rinkinys.
- `dashboard-css-coverage`: tuščias deklaracijų blokas ir `:not(.x)` selektorius klasės NEAPIBRĖŽIA;
  `i18n-coverage`: `LITERAL_KEY` priima `'…'`, `` `…` `` be interpoliacijos ir `t("…", …)`; `unused`
  ribą keisti į žinomų dinaminių raktų sąrašą su `length` asercija, kalibruota pagal korpusą.
- Kiekvienam sargui — po vieną „apėjimas dabar raudonas" atvejį testo viduje (fixture'as, ne korpusas);
  prieš griežtinant kiekvieną taisyklę Grep'u patikrinti, kad ESAMAS korpusas ją tenkina.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Jei sugriežtinta taisyklė nudažo draudžiamą korpuso failą
(`migration-coverage.json`, settings, `.md`), tą vieną taisyklę SIAURINK iki to, ką korpusas tenkina,
ir įrašyk radinį į ataskaitą — korpuso taisymas yra kitas task'as, o raudonas vartas blokuoja visus.

## Neįtraukta
- `hook-post-bash-sync` suvielinimas — audito „Nesuvielinti mechanizmai", kita sritis.
- `migration-coverage.json` įrašų turinio taisymas — atskiras task'as po šio varto.
- `markdown-readers-real-corpus`, `domain-tasks-etalonas-rules:321`, `pre-hooks:425` korpuso sargai
  (`length > 0`, realus `vq/`) — task 238 ir 240.
