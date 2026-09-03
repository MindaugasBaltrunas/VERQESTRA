# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 141-worktree-stop-hook-commitina-zalia-darba-arba-ivardija-kodel-ne

## Žingsnis 0 — ar jau įgyvendinta?
Jei dispatch launch biudžeto enforcement kelias (`dispatch-task.ts`
`enforceBudget` → `tool-budget-gates.ts enforceExecutionBudget`) task'ui su
galiojančia `HUMAN-REVIEW-APPROVED` žyma `context files N > M` priežastį
slopina su log eilute (kaip preflight risk kelias) ARBA kodo doc'as
EKSPLICITIŠKAI dokumentuoja, kad biudžeto kanalas žymos sąmoningai nepaiso
— ALREADY_IMPLEMENTED: cituok pasirinktos šakos kodą/doc'ą ir testą kaip
įrodymą.

## Tikslas
Vakaro parkavimo P2 (122, DU kartus — 10:31 ir 18:39): task'as su
galiojančia `HUMAN-REVIEW-APPROVED: mindebaltru 2026-09-01 ...` žyma (forma
teisinga — `domain/tasks/human-review/gates.ts:45` regex atitinka; 072
precedente ta pati žyma sėkmingai slopino RISK vartus: „risk gates
suppressed by HUMAN-REVIEW-APPROVED") vis tiek parkuojamas
`budget_enforcement_failed=context files 9 > 8` per dispatch launch.
Mechanizmas patikrintas — du kanalai žymą mato NEVIENODAI: (1) preflight
risk kelias (`claude-preflight/index.ts:182-194`) per
`analyzeHumanReviewGates` žymą atpažįsta ir slopina su log eilute;
(2) dispatch launch enforcement (`dispatch-task.ts:215-226` →
`ports.policy.enforceBudget` → `tool-budget-gates.ts:108-149`
`enforceExecutionBudget`, priežastis 134 eil.) yra GRYNA biudžeto aritmetika
— request'e (`run-coordinator-ports.ts:235`) nėra nei task teksto, nei
žymos, tad slopinimo galimybės kanalas fiziškai neturi. Dokumentuotas
dizainas prieštarauja (2): `assemble.ts:309-313` — „`max_files` šioje
sistemoje NĖRA karpymo limitas: preflight jį naudoja kaip ŽMOGAUS PERŽIŪROS
slenkstį" — žmogui peržiūrėjus ir patvirtinus, slenksčio kanalas, kuris
patvirtinimo nemato, tą patį task'ą parkuoja RATU (122 tai patyrė dukart).
Sprendimas — architect ŽINGSNIS tarp: (A) enforcement gerbia žymą —
`context files > max` (ir TIK ši, žmogaus-slenksčio kilmės priežastis;
ledger/hard limitai, model policy, tool allowlist NESLOPINAMI) su log
eilute „suppressed by HUMAN-REVIEW-APPROVED" kaip risk kelias; žymos faktas
atkeliauja per request lauką iš dispatch-task, kuris task tekstą turi;
(B) tai SĄMONINGA (biudžetas ≠ rizika: per didelis kontekstas kenkia
kokybei nepriklausomai nuo leidimo) — tada sprendimas dokumentuojamas
`tool-budget-gates.ts` doc'e su nuoroda į `assemble.ts:309-313` derinimą, o
122 klasei vienintelis legalus kelias yra `## Failai` trumpinimas — tai
įrašoma ir į assemble komentarą, kad dizaino tekstai nebeprieštarautų.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/token-governance/tool-budget-gates.ts`
- `src/application/task-execution/dispatch-task.ts` ((A) šaka — žymos
  fakto perdavimas request'e)
- `src/application/task-execution/run-coordinator-ports.ts` ((A) šaka —
  `enforceBudget` request forma)
- `src/composition/loop/coordinator-execution-adapters.ts` ((A) šaka —
  adapterio surišimas)
- `src/tests/token-governance-gates.test.ts`
- `src/tests/task-execution-run.test.ts` (deklaruotas ir 141 — todėl
  priklausomybė)

Draudžiama:
- `src/domain/tasks/human-review/gates.ts` (`analyzeHumanReviewGates` ir
  žymos regex teisingi — tik naudojami; DĖMESIO jo 78 eil. pastabai apie
  kontekstus, kur žyma sąmoningai negalioja — jos nekeisti)
- `src/interfaces/cli/dispatch/claude-preflight/index.ts` (risk suppression
  precedentas — nekeičiamas)
- `src/application/context-pack/assemble/assemble.ts` (309-313 doc
  komentaras — 101 queue scope; (B) šakos prieštaros suderinimas
  fiksuojamas ataskaitoje, ne čia)
- `vq/config/context-budget.json` ir kiti runtime konfigai (`max_files`
  reikšmė nekeliama — sprendimas apie ŽYMĄ, ne apie ribą)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect): (A) ar (B) su pagrindimu ataskaitoje. Svarstyti:
  (A) suderina abu kanalus su dokumentuotu „žmogaus peržiūros slenksčio"
  dizainu ir 072 precedentu; rizika — žyma taptų platesnio galiojimo, tad
  slopinimo apimtis SIAURA (tik `context files > max`); (B) pigus, bet
  palieka 122 klasę be išeities, kol Failai netrumpinami, ir reikalauja
  suderinti prieštaraujančius dizaino tekstus.
- (A) šaka: `enforceExecutionBudget` request gauna
  `humanReviewApproved?: string` (žymos turinys); kai jis yra, `context
  files > max` priežastis neįtraukiama, o rezultatas/log'as gauna
  „suppressed by HUMAN-REVIEW-APPROVED: <marker>" eilutę; VISOS kitos
  priežastys elgiasi kaip iki šiol. `dispatch-task.ts` žymą išsitraukia
  per `analyzeHumanReviewGates` (esamas domain kelias) iš task teksto.
- (B) šaka: sprendimas dokumentuojamas `tool-budget-gates.ts` doc'e;
  `assemble.ts:309-313` komentaro suderinimas NEDAROMAS čia (failas —
  101 queue task'o scope, sankirta be priklausomybės draudžiama) —
  prieštara fiksuojama ataskaitoje kaip likutis 101 vykdytojui ar
  atskiram mikro-pakeitimui; 122 atvejui — rekomendacija operatoriui
  trumpinti Failai.
- Testų lūkestis: (A) — (1) regresija: pack su 9 failais, max 8, žyma yra →
  ok su suppression log'u; (2) ta pati situacija be žymos → `context files
  9 > 8` kaip iki šiol; (3) ledger/model/tool priežastys su žyma
  NESLOPINAMOS; (B) — doc testų nereikia, bet esami enforcement testai
  žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei (A) šakoje paaiškėtų,
kad dispatch-task neturi patikimo kelio iki AKTYVAUS task teksto (pvz.
reformuluoto vs žalio teksto dviprasmybė — kuriame ieškoti žymos yra
kontrakto klausimas).

## Neįtraukta
- `max_files` ribos reikšmės keitimas — riba teisinga, klausimas tik apie
  patvirtinimo kanalą.
- Preflight `context files` kelio (`quality-gates/preflight.ts:154-155`)
  elgesys — jis jau yra žmogaus peržiūros SIUNTIMO pusė ir veikia teisingai;
  čia sprendžiamas tik POST-patvirtinimo enforcement.
- 122 task'o rankinis atblokavimas — operatoriaus veiksmas (requeue po šio
  task'o arba Failai trumpinimas pagal (B)).
- `turn-budget`/`preflight-limits` HUMAN-REVIEW-APPROVED paminėjimai
  (kalibracijos istorija) — nesusiję kanalai.
