# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 224-bundle-stale-pasiekia-runtimepanel-rebuild-klaida-matoma

## Žingsnis 0 — ar jau įgyvendinta?
Jei `PolicyProposalsPanel.tsx` `decide` turi `inFlight` (vykdymo metu mygtukai `disabled`/`aria-busy`),
`PolicyControlsPanel.tsx` `recommendedValue` grąžina `undefined` be `RECOMMENDED_VALUES` įrašo (ženklelio
nėra), o LT literalai „vykdoma/ok/klaida" ir „Reikšmė turi būti skaičius" eina per `t()` —
ALREADY_IMPLEMENTED: cituok `inFlight`, `recommendedValue` ir `t()` eilutes.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2; `scratchpad/audit-ui.md`
F5, F7, F6): (F5) `PolicyProposalsPanel.tsx:54-69` `decide` be `inFlight`, mygtukai `:183-213` be
`disabled` vykdymo metu — vienintelė mutacijų vieta be `useOperatorActions`/`inFlight` disciplinos;
dvigubas „Apply" → dvi `POST /api/policies/proposals/apply` → antra 409 (`ProposalNotApproved`), ekrane
„klaida - HTTP 409" po sėkmės. (F7) `PolicyControlsPanel.tsx:57-78` `recommendedValue =
RECOMMENDED_VALUES[id] ?? control.value` → `:102-109` dabartinei reikšmei prilipdomas „Rekomenduojama"
nustatymams be įrašo (`style`, `max_lines_per_file`, 7 iš 16 principų — `composition_over_inheritance`,
`law_of_demeter`, `encapsulation`, `immutability`, `fail_fast`, `explicit_over_implicit`,
`least_astonishment`): `style: "hexagonal"` rodo „hexagonal · Rekomenduojama", o pakeitus reikšmę
rekomendacija „pasikeičia" kartu. (F6) LT tekstai be rakto: `PolicyProposalsPanel.tsx:57,62,67`
(`vykdoma/ok/klaida`), `PolicyControlsPanel.tsx:26` — EN režime lietuviškai.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/dashboard/PolicyProposalsPanel.tsx`
- `ui-app/src/view/components/dashboard/PolicyControlsPanel.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/14-policy-forms.css` (`.proposal-actions` busy būsena, jei prireiks klasės)
- `ui-app/src/tests/view/components/dashboard/PolicyProposalsPanel.test.tsx`
- `ui-app/src/tests/view/components/dashboard/PolicyControlsPanel.test.tsx`

Draudžiama:
- `ui-app/src/controller/useOperatorActions.ts` (disciplina kartojama lokaliai, kontroleris nekinta)
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `src/**` (serverio rekomendacijos šaltinis — žr. Neįtraukta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `PolicyProposalsPanel.tsx`: `inFlight` raktas `${verb} ${policy_file}/${setting_id}` (arba pasiūlymo
  key); `decide` antrą kvietimą tam pačiam raktui ignoruoja; visi keturi mygtukai gauna `disabled` +
  `aria-busy`, kol vykdoma; būsenos tekstai per `t("running")/t("done")/t("failed")`-tipo raktus.
- `PolicyControlsPanel.tsx`: `recommendedValue(): … | undefined`; be įrašo — jokio `tag`; `:26`
  klaidos tekstas per `t()` (funkcija gauna `t` arba grąžina raktą, kurį kvietėjas verčia).
- Testai: dvigubas „Apply" siunčia VIENĄ POST ir mygtukas `disabled`; `style` be įrašo — ženklelio
  nėra, `strictness` su įrašu — yra; EN režime nėra lietuviškų literalų (`i18n-coverage` vartas žalias).
- Nauji raktai į `I18nContext.tsx` (LT+EN); nauja klasė (jei bus) — į `14-policy-forms.css`.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei rekomendacijų sąrašą reikėtų pildyti naujomis
reikšmėmis (kas rekomenduoja `style`?) — tai produkto sprendimas, ne UI; šis task'as tik nustoja meluoti.

## Neįtraukta
- Rekomenduojama reikšmė iš serverio (`UiPolicyControl.recommended_value` per `control-plane-model.ts`)
  — atskiras kontrakto task'as; čia klientas tik nerodo to, ko nežino.
- Kitos i18n aklosios zonos (HumanReviewPanel, DiagnosticsPanel, LearningPanel — 228; tokens — 229).
- `useOperatorActions` bendrinimas politikų panelėms — refaktoringas, ne klaida.
