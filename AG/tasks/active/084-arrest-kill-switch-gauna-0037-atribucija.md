# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
importuoja `attributeCanaryOutcome` / `selectArrestCountableHumanReviewTaskIds`
iš `application/context-pack/arrest-attribution.js` ir `humanReviewTaskIds`,
paduodami į `observeContextCompressionArrest`, yra atribucijos filtruotas
rezultatas (ne žalias `selectCanaryHumanReviewTaskIds` grąžinys), o
`src/tests/dead-export-gate.test.ts` nebeturi
`arrest-attribution.ts#selectArrestCountableHumanReviewTaskIds": "FORWARD"`
įrašo — ALREADY_IMPLEMENTED: cituoti importo ir kvietimo eilutes.

## Tikslas
2026-08-29 kompresijos posistemio auditas: arrest kill-switch skaičiuoja
human-review baigtis BE atribucijos.
`src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts:110`
paduoda žalią `selectCanaryHumanReviewTaskIds(...)` rezultatą tiesiai į
`observeContextCompressionArrest` (eil. 111) — kohortos task'ai, parkuoti
human-review dėl INFRASTRUKTŪROS (lease, worktree, evidence gates,
preflight), areštuoja kompresijos features, nors kompresija su baigtimi
neturi nieko bendro.

Deterministinė atribucija jau egzistuoja ir laukia prijungimo:
`src/application/context-pack/arrest-attribution.ts:245`
(`attributeCanaryOutcome`) ir `:284`
(`selectArrestCountableHumanReviewTaskIds` — NĖ VIENO produkcinio kvietėjo,
`src/tests/dead-export-gate.test.ts:269` žymi jį `"FORWARD"`). Teisingą
jungimo šabloną jau rodo analitika:
`src/application/analytics/compression-cohorts.ts:263`
(`attributeHumanReviewOutcomes`) — atribucijai reikia (a) task-events laukų
`phase`/`reason`/`exit_code` ir (b) `compression_applied` /
`compression_effect` iš context-size įrašų.

Svarbu dispatch pusei: composition `readTaskEvents`
(`src/composition/agent/dispatch-adapters.ts:81`) jau grąžina PILNUS
`parseJsonlObjects` objektus — siaurą tipą deklaruoja tik
`PrepareWorkerPromptDeps` (`worker-prompt-preparation.ts:40`), tad laukams
praplėsti composition keisti greičiausiai nereikia. Context-size įrašai
pasiekiami per jau esamą `deps.fs` + `deps.runtimeRoot`
(`readContextSizeMetrics` iš `application/context-pack/metrics.js`).

Sprendimo kryptis: prieš paduodant `humanReviewTaskIds` į
`observeContextCompressionArrest`, kiekviena kohortos human-review baigtis
perleidžiama per `attributeCanaryOutcome`, ir skaičiuojamas tik
`selectArrestCountableHumanReviewTaskIds` rezultatas. KUR gyvena jungimas
(application helper šalia arrest-attribution ar interfaces
worker-prompt-preparation viduje) ir IŠ KUR imamas `compression_effect`
istoriniam task'ui — architect sprendimas šio task'o viduje.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
- `src/application/context-pack/arrest-attribution.ts`
- `src/application/context-pack/compression-arrest-observer.ts`
- `src/tests/interfaces-cli-dispatch-runtime.test.ts`
- `src/tests/dead-export-gate.test.ts` (FORWARD žymos pašalinimas po
  prijungimo)

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/domain/policies/compression/arrest.ts` (lango logika ką tik
  pataisyta 2026-08-29 — nekeisti)
- `src/application/analytics/compression-cohorts.ts` ir
  `src/application/analytics/attempt-identity-join.ts` (analitikos pusė jau
  teisinga — tik pavyzdys, ne keitimo objektas)
- `src/composition/agent/dispatch-adapters.ts` (runtime jau grąžina pilnus
  objektus; prireikus naujo deps lauko — stop ir klausk)

## Veiksmas
- `worker-prompt-preparation.ts`: praplėsti `PrepareWorkerPromptDeps.readTaskEvents`
  grąžinamą tipą OPCIONALIAIS laukais (`phase`/`reason`/`exit_code` ar
  atitikmenimis), kad esami stub'ai (`async () => []`) toliau kompiliuotųsi.
- Prieš `observeContextCompressionArrest` kvietimą (eil. ~110): kiekvienam
  `selectCanaryHumanReviewTaskIds` grąžintam task id sujungti task-events
  baigties laukus su to task'o context-size įrašo
  `compression_applied`/`compression_effect`, perleisti per
  `attributeCanaryOutcome` ir paduoti tik
  `selectArrestCountableHumanReviewTaskIds` rezultatą.
- `dead-export-gate.test.ts:269`: išimti
  `selectArrestCountableHumanReviewTaskIds` FORWARD žymą.
- Testų lūkestis (`interfaces-cli-dispatch-runtime.test.ts`):
  infrastruktūrinė human-review baigtis (pvz. lease/worktree phase)
  NEBEDIDINA arešto skaitiklio; kompresijai atribuotina baigtis — didina;
  neperskaitomas/nesantis context-size įrašas nenulaužia dispatch'o
  (telemetrija, ne vartai).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei atribucijai reikėtų
naujo `PrepareWorkerPromptDeps` lauko, kurio composition surišimas
(`dispatch-adapters.ts`) negali patiekti be keitimo — composition šio
task'o scope nėra.

## Neįtraukta
Analitikos pusė (`compression-cohorts.ts`, `attempt-identity-join.ts`) —
jau teisinga, neliečiama. Arešto lango logika
(`domain/policies/compression/arrest.ts`) — pataisyta 2026-08-29 atskirai.
Silent-canary skaitiklio lango semantika — task 085 (nepriklausomas).
