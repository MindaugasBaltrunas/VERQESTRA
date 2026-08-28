# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/QueuePipelineBoard.tsx` nebeegzistuoja ir
`DashboardPage.tsx` `#/system` šakoje jo nerenderina — ALREADY_IMPLEMENTED.

## Tikslas
Operatoriaus nurodymas (2026-08-28): pašalinti „Eilės srautas" („Queue
pipeline" — scheduler'io būsena kiekvienai užduočiai: paruošta, vykdoma,
blokuojama, nepavyko, baigta) bloką iš `#/system` puslapio. Blokas dubliuoja
informaciją, kurią operatorius mato Tasks puslapyje ir WavesPanel srautuose.

Tai SĄMONINGAS cleanup pagal tiesioginį operatoriaus nurodymą — failų
trynimas čia yra užduoties esmė, ne šalutinis efektas. Šalinama pilnai, nes
`dead-export-gate.test.ts` neleidžia palikti eksporto be kvietėjo.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/QueuePipelineBoard.tsx` (TRINAMAS)
- `ui-app/src/view/components/QueuePipelineBoard.test.tsx` (TRINAMAS)
- `ui-app/src/model/queuePipelineViewModel.ts` (TRINAMAS)
- `ui-app/src/model/queuePipelineViewModel.test.ts` (TRINAMAS)
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/components/WavesPanel.tsx` (TIK pasenusio komentaro apie
  QueuePipelineBoard pataisymas)
- `ui-app/src/model/types.ts` (TIK komentaro eilutė ~738 apie
  queuePipelineViewModel)

Draudžiama:
- `ui-app/src/controller/**`
- `ui-app/src/model/api.ts`
- `src/**` (serverio `pipeline` duomenų šaltinis NEliečiamas — žr. Neįtraukta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `DashboardPage.tsx`: išimti `QueuePipelineBoard` ir `buildQueuePipeline`
  importus, `const pipeline = useMemo(...)` skaičiavimą (~94 eil.) ir
  renderio eilutę `{activeRoute === "system" && pipeline && ...}` (~303 eil.).
- Ištrinti keturis failus, pažymėtus TRINAMAS.
- `dashboard.css`: išimti „Queue pipeline board" sekciją (~1758–1833) ir
  responsive taisykles `.pipeline-board` (~3589, ~3600). Prieš trinant
  patikrinti, kad `pipeline-*` klasių nenaudoja joks kitas TSX.
- `I18nContext.tsx`: išimti raktus, kuriuos naudojo TIK QueuePipelineBoard
  („Queue pipeline" ir stulpelių pavadinimus) — prieš trinant patikrinti
  grep'u, kad rakto nenaudoja kitas komponentas.
- Pasenusius komentarus (`WavesPanel.tsx` ~42 eil., `types.ts` ~738 eil.)
  suderinti su nauja tikrove — nuorodą į nebeegzistuojantį komponentą
  pašalinti arba perrašyti.
- Po pakeitimų: `pnpm --dir ui-app build`, kad `ui-app/dist` atspindėtų
  pašalinimą (serveris dashboard'ą atiduoda iš dist).

## Patikra
- `pnpm typecheck && pnpm test`
- (dead-export ir CSS dengiamumo vartai — per šaknies `pnpm test`)

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Serverio pusė: `/api` `pipeline`/scheduler būsenos duomenų šaltinis lieka —
jį gali naudoti kiti skaitytojai, o miręs SERVERIO eksportas, jei toks
atsiras, yra atskiro audito sprendimas, ne šio UI cleanup'o. Kiti `#/system`
blokai (RuntimePanel, TokenBudgetPanel, WavesPanel, DiagnosticsPanel)
neliečiami.
