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
