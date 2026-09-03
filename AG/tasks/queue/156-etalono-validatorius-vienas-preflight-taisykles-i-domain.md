# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/quality-gates/preflight-fastpath.ts` `evaluateEtalonasRuleViolations`
nebeturi savų `evaluate*Rule` funkcijų, o kviečia `validateTaskAgainstEtalonas` iš
`src/domain/tasks/etalonas-rules.ts` ir tik projektuoja rezultatą į `EtalonasRuleViolation`
formą — ALREADY_IMPLEMENTED: cituok kvietimą ir domain failo rule id sąrašą, kuriame yra
`production-file-without-test` ir `ui-file-without-i18n-context`.

## Tikslas
Auditas `docs/audits/etalonas-tests-audit-2026-09-03.md` R1: etalono taisykles vykdo DU
skirtingi validatoriai. `src/domain/tasks/etalonas-rules.ts:1-3` antraštė teigia, kad hook'as ir
preflight'as abu importuoja `validateTaskAgainstEtalonas` — netiesa: vienintelis importas yra
`src/interfaces/hooks/pre-hooks.ts:30`, o `preflight-fastpath.ts:128-320` turi SAVO šešias
taisykles (`wildcard-scope-without-justification`, `production-file-without-test`,
`ui-file-without-i18n-context`, `ui-file-without-dashboard-css`, `patikra-without-backtick-check`,
`priklausomybes-placeholder`) su kitokiu wildcard apibrėžimu ir kitu placeholder žodynu.
Generatoriaus rašomi failai hook'o nepereina, tad loop'ui galioja silpnesnis rinkinys (pvz.
`pnpm typecheck` `## Patikra` sekcijoje praeina preflight'ą, o `pnpm test` tampa raudonas visiems).
Vienas validatorius domain'e — abu kvietėjai gauna tą patį verdiktą.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/application/quality-gates/preflight-fastpath.ts` (tik `evaluateEtalonasRuleViolations` ir jos pagalbinės)
- `src/tests/domain-tasks-etalonas-rules.test.ts`
- `src/tests/quality-gates-preflight.test.ts` (070-a-02 testas 479-499 eil.; failas 499 eil. — perkeliant taisyklių testus į domain testą jis TRUMPĖJA)

Draudžiama:
- `src/interfaces/hooks/pre-hooks.ts` (kvietėjas nekinta)
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts` (kvietėjas nekinta)
- `src/application/quality-gates/preflight-rules.ts`
- `AG/tasks/examples/000-etalonas.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `etalonas-rules.ts`: perkelti šešias preflight taisykles; `patikra-without-backtick-check`
  domain'e realizuojama per `taskBulletItems` (ne per `parseBacktickChecks` — application, domain
  jo importuoti negali) ir suliejama su esamu `checkPatikra`: komanda privalo būti backtick'uota
  IR iš leistinų formų (dabar `checkPatikra` 202 eil. backtick'us nuima ir bullet'ą be jų praleidžia).
  Wildcard apibrėžimas — VIENAS (`**` arba `xxx/` gale, kaip domain'e); placeholder žodynas —
  `isPlaceholderDependency`, `preflight-fastpath` savo `DEPENDENCY_PLACEHOLDER_TOKENS` netenka.
- `Violation` tipas gauna neprivalomus `citation`/`detail` laukus, kad preflight kvietėjas
  toliau matytų etalono citatą; preflight rule id lieka nepakitę (juos cituoja
  `preflight-llm.ts` doc'as ir `interfaces-cli-preflight.test.ts:228`).
- `validateTaskAgainstEtalonas(text, knownTaskIds?)`: `knownTaskIds === undefined` reiškia
  „id rezoliucija netikrinama" (preflight kelias id sąrašo neturi), ne „visi nežinomi".
- `preflight-fastpath.ts` `evaluateEtalonasRuleViolations` = plonas adapteris virš domain
  validatoriaus; antraštė `etalonas-rules.ts:1-3` tampa tiesa.
- Testai: kiekvienai iš 10 taisyklių po blokavimo ir praėjimo atvejį domain teste; etalono
  failas ir `VALID_TASK` toliau grąžina `[]`; 070-a-02 testas `quality-gates-preflight.test.ts`
  lieka tik adapterio formos (citata, rule id) ir korpuso (`AG/tasks/queue/*.md`) patikra.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei korpuso testas ant `AG/tasks/queue/*.md`
kristų dėl suvienodintos taisyklės (pvz. griežtesnis wildcard ar Patikra) — tai task'o
teksto, ne validatoriaus klaida, ir ją taiso operatorius, ne šis task'as.

## Neįtraukta
- Naujos taisyklės (prozinė priklausomybė, anotacija bloke, Leidžiama∩Draudžiama, tuščias
  Neįtraukta, CONTEXT_CACHE_VERSION pin'ai, readme-guard pirmas) — task 157.
- Vienas `## Failai` kelių skaičius ir viena riba (`size.ts` filtras vs `tool-budget-gates.ts`
  nefiltruotas; 8/10/8 konfigai) — atskiras task'as.
- Etalono `> N.` punktų inventoriaus sync testas.
