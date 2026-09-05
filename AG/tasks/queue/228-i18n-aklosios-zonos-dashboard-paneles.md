# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 227-policy-panelese-inflight-rekomenduojama-ir-lt-tekstai

## Žingsnis 0 — ar jau įgyvendinta?
Jei `I18nContext.tsx` žodynas turi raktus „Approve / Requeue", „Complete" ir šešias `control-plane-model.ts:343-354`
etiketes („Auto commit after successful checks", „Auto push after commit", „Require Conventional Commits",
„Prepare PR after successful task", „Generate release notes after final audit", „Architecture governance
workspace"), o `LearningPanel.tsx:92-93` tekstai eina per `t()` — ALREADY_IMPLEMENTED: cituok raktus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2; `scratchpad/audit-ui.md` F6):
`i18n-coverage.test.ts:16-17` sąmoningai nemato dinaminių raktų — tai varto akloji zona, ir joje jau
gyvena klaidos. `HumanReviewPanel.tsx:8-11` `ACTION_LABEL` → `t("Approve / Requeue")`, `t("Complete")`
(`:99,118,126`) — žodyne NĖRA → LT režime angliški mygtukai peržiūrų ekrane. `DiagnosticsPanel.tsx:75`
`t(control.label)` — serverio etiketės iš `control-plane-model.ts:343-354`, nė vienos žodyne (patikrinta
grep'u; „Max lines per file" klasė iš 18-o rato). `LearningPanel.tsx:93` „evidence items" be rakto, `:92`
Badge su neišverstu `statusLabel`. Vartas šių raktų nepagaus — todėl juos turi pin'inti komponentų
testai (LT režime nėra angliško literalo). Tokens komponentai ir `lt-LT` formateriai — task 229.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/dashboard/HumanReviewPanel.tsx` (8-11, 99, 118, 126 eil.)
- `ui-app/src/view/components/dashboard/DiagnosticsPanel.tsx` (75 eil. — raktai žodyne, kodas nekinta)
- `ui-app/src/view/components/dashboard/LearningPanel.tsx` (92-93 eil.)
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/18-command-center-blocks.css` (naujų klasių nenumatoma; deklaruota CSS varto reikalavimu — jei prireiktų, ji gyvena čia)
- `ui-app/src/tests/view/components/dashboard/HumanReviewPanel.test.tsx`
- `ui-app/src/tests/view/components/dashboard/DiagnosticsPanel.test.tsx`
- `ui-app/src/tests/view/components/dashboard/LearningPanel.test.tsx`

Draudžiama:
- `src/interfaces/ui-model/control-plane-model.ts` (etiketės yra serverio kontraktas — verčiamos kliente)
- `ui-app/src/tests/gates/i18n-coverage.test.ts` (varto taisyklė — task 236)
- `ui-app/src/model/types.ts`, `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `HumanReviewPanel.tsx`: `ACTION_LABEL` reikšmės tampa žodyno raktais (LT+EN įrašai); komponentas
  toliau kviečia `t(ACTION_LABEL[action])`.
- `I18nContext.tsx`: šešios `control-plane-model.ts:343-354` etiketės kaip raktai su LT vertimais
  (komentaras šalia: „dinaminiai raktai iš serverio — vartas jų nemato, pin'ina `DiagnosticsPanel.test`").
- `LearningPanel.tsx`: „evidence items" per `t()`; `statusLabel` — per žodyno raktą pagal statusą
  (`pending`/`approved`/…), ne žalia serverio reikšmė.
- Testai: kiekvienam komponentui LT režimo renderis (`I18nProvider` su `lt`) — nė vieno iš aukščiau
  išvardytų angliškų literalų DOM'e; EN režimas nekinta.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei serverio etikečių sąrašas `control-plane-model.ts`
turi daugiau įrašų nei šeši Tiksle — tada verčiami VISI (grep'ink `label:` tame faile), ne tik audito
paminėti.

## Neįtraukta
- Tokens komponentų tekstai ir `lt-LT` hardcoded formateriai — task 229.
- Vartas dinaminiams raktams (`i18n-coverage`) — task 236 (žinomų dinaminių raktų sąrašas).
- `PolicyProposalsPanel`/`PolicyControlsPanel` LT literalai — task 227.
