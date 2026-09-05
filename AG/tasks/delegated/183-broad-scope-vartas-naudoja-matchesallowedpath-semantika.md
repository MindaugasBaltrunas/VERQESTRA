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
Jei `src/application/quality-gates/preflight-rules.ts` `broad_scope_requires_human_review` šaka
(451-457 eil.) nebenaudoja regex'o `/^(\*\*|.+\/\*\*)$/`, o kelią `src/` ir `src/**/*.ts` laiko broad
per `matchesAllowedPath` semantiką (yra testas `quality-gates-preflight.test.ts`, kuris `src/` duoda
`policy broad_scope_requires_human_review`), IR `missingTaskSections` (195-201 eil.) nebenaudoja
`content.includes(...)` — ALREADY_IMPLEMENTED: cituok helper'į ir testus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, A1 ✓, QG-2, CP-2 preflight dalis).
A1: `preflight-rules.ts:453` regex mato tik `**` ir `x/**`; `matchesAllowedPath`
(`src/domain/tasks/allowed-paths.ts:189`) kelią `src/` laiko viso medžio prefiksu, o `src/**/*.ts` —
bet kokio gylio glob'u. `Leidžiama: - \`src/\`` → nei manual, nei loop preflight neparkuoja, diagnozė
leidžia rašyti bet kur `src`. Korpuse `AG/tasks/done` `src/` deklaravo 043-a-02, 056, 056-a-02.
Repo turi tris „wildcard" apibrėžimus (šis regex; etalonas `isWildcardPath`; `detectHallucinatedAllowedPaths`
`includes("*")`). Kryptis: broad = kelias, kuris per `matchesAllowedPath` dengia KATALOGĄ, ne failą:
`**`, `x/**`, `x/` (prefiksas be plėtinio), `x/**/*.ext` ir `x/*` — sprendžiama per tą pačią funkciją
(pvz. `matchesAllowedPath(path, "<solid-prefix>/__probe__/__probe__.ts")` arba `endsWith("/")` +
`includes("**")`), NE per naują regex'ą. Konkretus failas su `*` viename segmente (`src/a/*.ts`)
irgi dengia katalogą — broad. Taisyklė yra `enforcementPolicy.broad_scope_requires_human_review`
vartas: task'as parkuojamas human-review, ne raudonas testas.
QG-2: `preflight-rules.ts:195-201` `missingTaskSections` — `content.includes("# Task")` (substring:
`## Tasks`, `## Stop condition`, fenced pavyzdys tenkina), o `preflight.ts:181-183` `hasHeading` —
tiksli trim'inta eilutė. Komentaras 95-96 eil. „cannot drift" — netiesa. Kryptis: vienas matcher'is
(tiksli eilutė) abiem.
CP-2 (preflight dalis): `preflight.ts:151` `taskText.length > max_context_chars` lygina TASK TEKSTO
ilgį su pack'o biudžetu ir praneša „context chars" — kitą dydį nei enforcement
(`tool-budget-gates.ts:149`) ir assemble. Kryptis: priežastis įvardija, kas matuojama (`task chars`),
arba palyginimas šalinamas iš preflight'o (pack'o dar nėra) — architekto sprendimas su doc'u.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts` (451-457 broad; 195-201 `missingTaskSections`)
- `src/application/quality-gates/preflight.ts` (181-183 `hasHeading`; 151 eil. `context chars`)
- `src/tests/quality-gates-preflight.test.ts`

Draudžiama:
- `src/domain/tasks/allowed-paths.ts` (`matchesAllowedPath` importuojamas, nekeičiamas — task 178/181)
- `src/domain/tasks/etalonas-rules.ts` (`isWildcardPath` — task 181)
- `src/application/token-governance/tool-budget-gates.ts` (enforcement dydis — task 190)
- `src/interfaces/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `preflight-rules.ts`: `isBroadScopePath(path)` ant `matchesAllowedPath` (importas iš
  `../../domain/tasks/allowed-paths.js`); 453 eil. regex'ą pakeisti kvietimu; doc'e įvardyti, kad
  etalonas (`isWildcardPath`) reikalauja tik pagrindimo, o šis vartas — human-review, ir tai tyčia.
- `missingTaskSections`: eilutės lygis (`split(/\r?\n/)`, `trim() === heading`), tas pats helper'is
  eksportuojamas ir naudojamas `preflight.ts` `hasHeading` vietoje; 95-96 eil. komentarą suderinti.
- `preflight.ts:151`: pervadinti priežastį į `task chars N > M` (ir doc), arba pašalinti — pagal
  architekto sprendimą; jei pervadinama, patikrinti, ar `quality-gates-preflight.test.ts` pina
  seną tekstą.
- KORPUSO PATIKRA PRIVALOMA (task 157 pamoka): Grep'u per `AG/tasks/queue/*.md` (2026-09-05 eilėje
  163-166 ir 178+) ir `AG/tasks/done/*.md` `Leidžiama:` bullet'us, kuriuos nauja taisyklė laikytų
  broad (`src/`, `x/`, `x/**/*.ts`, `x/*`). Queue task'ai su tokiu keliu po merge'o būtų parkuojami
  human-review — jų failų šio task'o scope nėra: sąrašą įrašyti į ataskaitą ir žr. Stop.
  `done` korpusas nebepreflight'inamas — tik ataskaitai.
- Testai `quality-gates-preflight.test.ts`: `src/` → review reason `policy broad_scope_requires_human_review`;
  `src/**/*.ts`, `ui-app/src/*` → tas pats; `src/index.ts`, `src/a/b.ts` → be; `**`/`src/**` — kaip iki
  šiol; `missingTaskSections` su `## Tasks` ir fenced `# Task` pavyzdžiu → `# Task` TRŪKSTA.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei korpuso Grep'as randa `AG/tasks/queue` task'ą,
kurio `Leidžiama:` kelią nauja taisyklė laikytų broad — vartai lieka žali (tai preflight parkas, ne
testas), tad sustojimas veikia; operatorius nusprendžia, ar tas task'as gauna pagrindimą/žymą.

## Neįtraukta
- Etalono `isWildcardPath` ir `detectHallucinatedAllowedPaths` suvienodinimas — task 181 (etalonas)
  ir task-planning autorius (hallucinated paths).
- Enforcement/assemble/persist „max_context_chars" dydžių suderinimas — task 190.
- `SOURCE_CHANGE_PATTERN` (route-model) vs `preflight-rules.ts:27-58` dublikatas (TG-2) — task 195.
