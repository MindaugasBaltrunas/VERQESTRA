# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 223-api-dashboard-nesa-ui-rebuild-busena

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/pages/DashboardPage.tsx` `<RuntimePanel …>` (323-345 eil.) paduoda
`bundleStale={raw?.bundle_stale}` ir `uiRebuild={raw?.ui_rebuild}`, o `RuntimePanel.tsx` serverio
`failed` būseną rodo su `tail` — ALREADY_IMPLEMENTED: cituok prop'ų eilutes ir `failed` renderį.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, U1 ✓; `scratchpad/audit-ui.md` F2):
serveris prie kiekvieno `/api/dashboard` prisega `bundle_stale` (`ui-router.ts:120-128`), kliento tipas
jį deklaruoja (`types.ts:331-333`), `RuntimePanel.tsx:100,177-179,360` jo laukia — bet
`DashboardPage.tsx:323-345` prop'o NEPADUODA (grep `bundleStale` produkcijoje: tik `RuntimePanel.tsx`;
`raw.bundle_stale` — niekur). Pasekmė: „Rebuild dashboard" po paspaudimo lieka `running` iki puslapio
perkrovimo, „bundle pasenęs" įspėjimas niekada nepasirodo, nepavykęs build'as nematomas. Testai
(`RuntimePanel.test.tsx:706-770`) prop'ą paduoda ranka, tad vartas žalias — „mechanizmas be wiring'o".
Po task 223 `/api/dashboard` neša ir `ui_rebuild` (`ok|running|failed`, `tail`). Kartu pataisomi F4
pasenę komentarai apie `/tasks/resume` (`RuntimePanel.tsx:53-58`, `DashboardPage.tsx:326-327`) —
Header'io „Paleisti" nuo task 049 eina per `/api/runtime/loop/start`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx` (RuntimePanel prop'ai 323-345 eil.; komentaras 326-327 eil.)
- `ui-app/src/view/components/dashboard/RuntimePanel.tsx` (`uiRebuild` prop'as, `failed` + uodega; komentaras 53-58 eil.)
- `ui-app/src/model/types.ts` (`DashboardData.ui_rebuild?` šalia `bundle_stale`, 327-333 eil.)
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/04-runtime.css` (uodegos `<pre>` klasė šalia `.runtime-explanation`)
- `ui-app/src/tests/view/components/dashboard/RuntimePanel.test.tsx`
- `ui-app/src/tests/app/dashboardSmoke.test.tsx` (fixture su `bundle_stale`/`ui_rebuild` per DashboardPage)

Draudžiama:
- `ui-app/src/model/api.ts` (kontraktas nekinta — laukai neprivalomi)
- `ui-app/src/model/dashboardContract.ts` (`parseDashboardData` privalomų laukų sąrašas nekinta)
- `ui-app/src/controller/useDashboardController.ts` (`raw` jau pasiekia puslapį, 351 eil.)
- `src/**` (task 223)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `types.ts`: `ui_rebuild?: { status: "ok" | "running" | "failed"; tail?: string }` — neprivalomas, kaip
  `bundle_stale` (senas serveris jo nesiunčia).
- `DashboardPage.tsx`: `bundleStale={raw?.bundle_stale}` ir `uiRebuild={raw?.ui_rebuild}`; komentarą
  326-327 eil. pakeisti tiesa (abu „Paleisti" eina per `/api/runtime/loop/start`).
- `RuntimePanel.tsx`: serverio `running` → `rebuildState = "running"` (išgyvena perkrovimą); `failed` →
  `"failed"` su `rebuildReason` iš `tail` ir `<pre>` uodega; `ok` + `bundleStale === false` → `succeeded`
  (esama logika); lokalus paspaudimas turi pirmenybę tik iki pirmo serverio atsakymo. Komentarą 53-58 eil.
  suderinti su 049.
- Testai: DashboardPage (smoke) — `bundle_stale: true` fixture rodo įspėjimą BE rankinio prop'o;
  RuntimePanel — `uiRebuild.failed` rodo uodegą ir atrakina mygtuką, `running` iš serverio užrakina,
  senas serveris be lauko — elgesys kaip iki šiol.
- Nauji tekstai — į `I18nContext.tsx` (LT+EN); nauja klasė — į `04-runtime.css` (CSS dengiamumo vartas).

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `parseDashboardData` reikalautų naujų PRIVALOMŲ
laukų — sena `dist` versija jų nesiunčia, ir toks kontraktas paverstų visą ekraną klaida.

## Neįtraukta
- Serverio `ui_rebuild` laukas — task 223.
- Automatinis UI serverio restartas po pasenusio dist — operatoriaus politika (task 162 log'as).
- `PolicyProposalsPanel`/`PolicyControlsPanel` pataisos — task 227.
