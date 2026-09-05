# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 224-bundle-stale-pasiekia-runtimepanel-rebuild-klaida-matoma

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/model/api.ts` nebeturi `resumeLoop` (grep `tasks/resume` per `ui-app/src` = 0) ir
`ui-app/src/model/types.ts` nebeturi `queueCounts` — ALREADY_IMPLEMENTED: cituok grep rezultatus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2; `scratchpad/audit-ui.md`
F4, F8): `api.ts:157-161` `resumeLoop` → `POST /tasks/resume` kliente nekviečiamas nuo task 049
(`useDashboardController.ts:37-43` komentaras „lieka api.ts kitiems vartotojams" — vartotojų nėra;
Header eina per `/api/runtime/loop/start`); gyvas tik `apiEnvelopes.test.ts:14,55,61`. Serverio
maršrutą šalina task 226. `types.ts:310` `DashboardData.queueCounts?` — serveris lauką pašalino
2026-08-24, kliento tipas ir fixture'ai (`accessibility.test.tsx:42`, `dashboardSmoke.test.tsx:48`)
tebeneša; tie patys fixture'ai (`:47`, `:53`) neša `loop_controls` veiksmą su `endpoint: "/tasks/resume"`,
kurį serveris pašalino tą pačią dieną (`control-plane-model.ts:361`). Miręs kliento kodas ir fixture'ai,
liudijantys neegzistuojantį kontraktą, yra būtent tai, ką `dashboardContract` turėjo uždaryti.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts` (`resumeLoop` 157-161 eil. šalinamas; `LoopResult` importas lieka, jei naudojamas kitur)
- `ui-app/src/model/types.ts` (310 eil. `queueCounts?`; 135 eil. komentaras apie `/tasks/resume`)
- `ui-app/src/controller/useDashboardController.ts` (37-43 ir 314 eil. komentarai — be `/tasks/resume` legendos)
- `ui-app/src/tests/model/apiEnvelopes.test.ts` (14, 55, 61 eil.)
- `ui-app/src/tests/app/accessibility.test.tsx` (42, 47 eil. fixture)
- `ui-app/src/tests/app/dashboardSmoke.test.tsx` (48, 53 eil. fixture)

Draudžiama:
- `ui-app/src/model/dashboardContract.ts` (privalomų laukų sąrašas nekinta)
- `ui-app/src/tests/app/dashboardActionFeedback.test.ts` ir `ui-app/src/tests/controller/useDashboardController.test.ts` (`vi.mock` su pertekliniu `resumeLoop: vi.fn()` raktu nelūžta — neliečiami)
- `src/**` (task 226)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `api.ts`: pašalinti `resumeLoop`; patikrinti, kad `requireLoopEnvelope` ir `LoopResult` tebeturi
  kvietėjus (`startLoopWithWorkers`, `stopLoop`) — jei ne, šalinti kartu.
- `types.ts`: pašalinti `queueCounts?`; 135 eil. komentarą perrašyti be `/tasks/resume`.
- Fixture'ai: `queueCounts` ir `loop_controls`/`/tasks/resume` veiksmas išimami iš `accessibility` ir
  `dashboardSmoke` fixture'ų; jei kuris testas TIKRINO tą veiksmą — asercija keičiama į
  `/api/runtime/loop/start` kelią, ne trinama.
- `apiEnvelopes.test.ts`: `resumeLoop` importas ir du testai šalinami; voko taisyklę tebeliudija
  `startLoopWithWorkers`/`stopLoop` atvejai.
- `useDashboardController.ts`: komentarai 37-43 ir 314 eil. — tiesa po 049 (vienas kelias, ne du).

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `accessibility.test.tsx` fixture'o `actions`
sąrašas yra vienintelis būdas pasiekti kurią nors a11y aserciją — tada veiksmas keičiamas gyvu, ne
trinamas.

## Neįtraukta
- Serverio `/tasks/resume` šaka ir jos kontraktų testas — task 226.
- `feature_pairs`, `UiWaveSlot.phase|last_event` rodymas — task 231.
- `mobile-app`/`mobile-gateway` klientai — į `pnpm test` neįeina; grep 2026-09-05 rodo 0 kvietėjų.
