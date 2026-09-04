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
AG/openspec/changes/verqestra-backlog-v1/
## Tikslas
Po 156-a domain etalonas-rules.ts turi visas 10 taisyklių. Perrašyti `evaluateEtalonasRuleViolations` (preflight-fastpath.ts) į plony adapterį virš `validateTaskAgainstEtalonas`, kad hook'as ir preflight'as vykdytų TĄ PATĮ validatorių — antraštė etalonas-rules.ts:1-3 tampa tiesa. Šis darbas PRIKLAUSO nuo 156-a (domain taisyklių sujungimo) — turi būti mergintas po jo.
## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester
## Failai
Leidžiama:
- `src/application/quality-gates/preflight-fastpath.ts` (tik `evaluateEtalonasRuleViolations` ir jos pagalbinės funkcijos/tipai)
- `src/tests/quality-gates-preflight.test.ts` (070-a-02 testas ~479-499 eil.)
Draudžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/interfaces/hooks/pre-hooks.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts`
- `src/application/quality-gates/preflight-rules.ts`
- `dist/**`
- `node_modules/**`
## Veiksmas
- `evaluateEtalonasRuleViolations` perrašyti į ploną adapterį: kviečia `validateTaskAgainstEtalonas(taskText)` (be knownTaskIds) ir projektuoja domain `Violation` į `EtalonasRuleViolation` (ruleId/citation/detail); `EtalonasRuleId` reikšmės ir eksportuojamas tipas NEKINTA (juos cituoja preflight-llm.ts ir interfaces-cli-preflight.test.ts:228).
- Pašalinti pasenusias savas funkcijas (evaluateWildcardScopeRule, evaluateProductionFileTestRule, evaluateUiCoverageRule, evaluatePatikraBacktickRule, evaluateDependencyPlaceholderRule) ir `DEPENDENCY_PLACEHOLDER_TOKENS` žodyną — juos pakeičia domain importas.
- Atnaujinti 070-a-02 testą quality-gates-preflight.test.ts, kad tikrintų tik adapterio formą (citata, rule id perduodamas nepakitęs) ir korpuso (`AG/tasks/queue/*.md`) patikrą.
## Patikra
- `pnpm build`
- `pnpm test`
## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei kuris nors `AG/tasks/queue/*.md` pradeda kristi po perjungimo prie domain validatoriaus — task teksto, ne kodo klaida.
## Neįtraukta
Naujos taisyklės (task 157). Failai kelių skaičiaus/ribos suvienodinimas — atskiras task'as. Etalono `> N.` punktų inventoriaus sync testas.
