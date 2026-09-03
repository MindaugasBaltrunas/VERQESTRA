# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/token-governance/turn-budget.ts` `DEFAULT_TURN_LIMITS` turi `medium: 90` ir
`repair: 45`, o `resolveDispatchTurnTier` (`token-budget-optimizer.ts`) priima `escalated` įėjimą
ir su juo grąžina `tier: "large"` — ALREADY_IMPLEMENTED: cituok abu ir `dispatch-budget-plan.ts`
vietą, kur `escalated` paduodamas iš routing plano.

## Tikslas
Modelių auditas `docs/audits/model-efficiency-audit-2026-09-03.md` R1–R3 (`token-usage.jsonl`,
306 dispatch'ų): **15 dispatch'ų baigė tiksliai 61 turn'u — 13 failed** (`turnLimits.medium: 60`);
14 pakartotinių bandymų — 10 pavyko, o **visi 4 nepavykę baigė ties lubomis** (31, 31, 31 ir 61;
`repair: 30`). Mediana 30 turn'ų, p75 47; `large: 180` per 13 dienų nepasiekta nė karto. Vienintelė
eskalacija (task 030, 3-ias bandymas, opus) buvo nukirsta ties 61 turn'u už 4,4 $: routing'as
pakėlė MODELĮ (`MODEL ESCALATION`), bet turn'ų biudžetas liko `medium`, nes `resolveDispatchTurnTier`
apie eskalaciją nežino (`dispatch-budget-plan.ts:47-51` gauna tik `publishedTier` ir metrikas).
Kaina: ≈ 46 $ nukirsto darbo + repair/human-review ratai. Sprendimas: medium 60→90, repair 30→45
(abu žemiau p95, aukščiau p92 uodegos), o eskaluotas bandymas paveldi `large` turn'ų biudžetą —
stipresnis modelis be didesnio lango yra opus kaina už sonnet lubas.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/token-governance/turn-budget.ts` (`DEFAULT_TURN_LIMITS` 35-41 eil. ir kalibracijos komentaras)
- `templates/vq/config/token-budget.json` (tos pačios reikšmės; gyvas `vq/config/token-budget.json` — operatoriaus žingsnis, runtime negit'inamas)
- `src/application/token-governance/token-budget-optimizer.ts` (`resolveDispatchTurnTier` 68-99 eil.)
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-budget-plan.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts` (tik `resolveDispatchBudgetPlan` kvietimas 255-264 eil.)
- `src/tests/token-governance-turn-budget.test.ts` (numatomas naujas — `interfaces-cli-dispatch-plan.test.ts` ir `quality-gates-preflight.test.ts` yra po 499 eil.)
- `src/tests/interfaces-cli-dispatch-plan.test.ts` (tik jei esamas pin'as remiasi literalu 60/30)

Draudžiama:
- `src/application/token-governance/route-model.ts` (eskalacijos taisyklė nekinta — `defer_steps` lieka 1)
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.ts`
- `src/application/token-governance/token-budget-config.ts` (`MAX_CONFIGURABLE_TURNS: 300` lubos nekinta)
- `vq/config/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `turn-budget.ts`: `medium: 60 → 90`, `repair: 30 → 45`; kalibracijos komentaras papildomas
  2026-09-03 duomenimis (15 × 61, 13 failed; 4/4 repair nesėkmės ties 31/61). `small`, `large`,
  `semanticReview` nekinta. `templates/vq/config/token-budget.json` — tos pačios reikšmės.
- `token-budget-optimizer.ts` `resolveDispatchTurnTier`: naujas įėjimas `escalated?: boolean`
  (`routing.tier !== routing.base_tier`); `true` → `tier: "large"`, `source: "escalated"`,
  `sourceLabel: "escalated"`, priežastis vardija bazinį tier'ą. Soft `reduced` kelias eskaluotam
  bandymui NEtaikomas — eskalacija jau yra sprendimas leisti daugiau. `TurnTierSource` gauna
  `"escalated"`.
- `dispatch-budget-plan.ts`: `DispatchBudgetPlanInput.escalated?: boolean` perduodamas į
  `resolveDispatchTurnTier`; `DISPATCH TURN BUDGET` eilutėje `source=escalated` (be tarpų).
- `command.ts:255-264`: `escalated: routing.tier !== routing.base_tier` — tas pats palyginimas,
  kurį `dispatch-routing-plan.ts:73` naudoja `MODEL ESCALATION` eilutei.
- Testai (naujas failas): default'ai 90/45; `resolveDispatchTurnTier` su `escalated: true` ir
  `publishedTier: "medium"` → `large`/`escalated`; be `escalated` elgsena baitas-į-baitą kaip iki
  šiol (esami `interfaces-cli-dispatch-plan` testai lieka žali); `resolveMaxTurns({phase:
  "implementation", tier: "large"})` eskaluotam bandymui = 180 su `dispatchMaxTurns` lubomis.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `resolveDispatchTurnTier` naujas įėjimas
reikalautų keisti `PublishedTierDecision` ar preflight'o skelbiamą `token_budget_tier` — eskalacija
yra dispatch'o laiko faktas ir preflight'o sprendimo neliečia.

## Neįtraukta
- `defer_steps` (1 → 0) ir klasifikacijos `advanced` iš kelių — eksperimentas po 2 savaičių
  duomenų su naujomis lubomis (modelių auditas R5).
- Preflight LLM modelis — task 160.
- Gyvo `vq/config/token-budget.json` redagavimas — operatorius, po merge.
