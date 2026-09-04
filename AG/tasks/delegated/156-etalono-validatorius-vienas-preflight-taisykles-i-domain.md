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
Audito docs/audits/etalonas-tests-audit-2026-09-03.md R1: `evaluateEtalonasRuleViolations` (preflight-fastpath.ts) turi SAVO 5 funkcijas / 6 rule id, atskiras nuo domain `validateTaskAgainstEtalonas` (etalonas-rules.ts), su kitokiu wildcard apibrėžimu ir placeholder žodynu. Šis darbas suvienodina taisykles VIENAME domain faile — antras vaikas (156-b) vėliau perjungs preflight-fastpath.ts prie jo per plony adapterį.
## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester
## Failai
Leidžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/tests/domain-tasks-etalonas-rules.test.ts`
Draudžiama:
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/application/quality-gates/preflight-rules.ts`
- `src/interfaces/hooks/pre-hooks.ts`
- `dist/**`
- `node_modules/**`
## Veiksmas
- `Violation` tipui pridėti neprivalomus `citation`/`detail` laukus; `validateTaskAgainstEtalonas` antrą parametrą `knownTaskIds` padaryti neprivalomą (undefined = id rezoliucijos patikra praleidžiama).
- Perkelti į etalonas-rules.ts keturias preflight-fastpath.ts taisykles (production-file-without-test, ui-file-without-i18n-context, ui-file-without-dashboard-css, patikra-without-backtick-check sulieta su esamu checkPatikra per taskBulletItems), naudojant VIENĄ wildcard apibrėžimą (`**` arba `/` gale, kaip checkFailaiWildcards) ir `isPlaceholderDependency` žodyną vietoj application savo DEPENDENCY_PLACEHOLDER_TOKENS.
- Domain-tasks-etalonas-rules.test.ts: kiekvienai naujai perkeltai taisyklei po blokavimo ir po praėjimo atvejį; patikrinti, kad etalono failas ir esami VALID_TASK atvejai toliau grąžina [].
## Patikra
- `pnpm build`
- `pnpm test`
## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei kokia nors korpuso taisyklė (AG/tasks/queue/*.md) pradeda kristi dėl suvienodinto wildcard ar patikra apibrėžimo — tai task teksto, ne validatoriaus klaida.
## Neįtraukta
Preflight-fastpath.ts adapterio perrašymas ir quality-gates-preflight.test.ts atnaujinimas — vaikas 156-b (priklauso nuo šio darbo). Naujos taisyklės (task 157). Failai kelių skaičiaus/ribos suvienodinimas — atskiras task'as.
