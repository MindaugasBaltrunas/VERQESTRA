# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/task-execution/bucket-transition.ts` jau importuoja ir
kviečia `stripVerificationPreamble` prieš perkėlimą (grep
`stripVerificationPreamble` tame faile duoda radinį) IR
`src/interfaces/http/ui-task-actions.ts:205` perkėlimas nebeeina tiesiai
per `ports.store.moveTaskState` be nuėmimo —
ALREADY_IMPLEMENTED: nurodyk failus ir eilutes, kuriose strip patenka į
perėjimo kelią.

## Tikslas
Task failas bucket'uose gyvena dviem formomis: kanonine (etalono struktūra
nuo `# Task`) ir dispatch'o (priekyje `verificationPreamble` — `## Žingsnis 0`
+ `## Sandbox taisyklės` blokai, `src/application/quality-gates/preflight-rules.ts:147`).
Koordinatorius preambulę instaliuoja tiesiai į bucket failą
(`src/composition/loop/coordinator-adapters.ts:139-145`,
`installReformulatedTask`), o VISI tolesni perkėlimai yra žali failo move be
turinio transformacijos (`src/application/task-execution/bucket-transition.ts`
→ `store.moveTaskState`/`finishTaskState`). Todėl parkavimas į human-review
ir requeue (`src/interfaces/cli/task-queue/requeue.ts:47`) perneša dispatch'o
formą į human-review ir queue, kur nuo 071/071-a-02 galioja etalono
struktūros vartai. Realus incidentas 2026-08-30: requeue'inti 072 ir
075-a-02 su preambule sulaužė konformance testą
(`src/tests/interfaces-hooks-pre-hooks.test.ts:405`) — visos sesijos
stop-blocked, taisyta rankomis. Sprendimo invariantas: queue, done,
human-review (ir error) — VISADA kanoninė forma; dispatch'o forma leidžiama
TIK active/delegated bandymo lange. Kiekvienas kelias iš lango atgal nuima
preambulę deterministiškai per JAU ESAMĄ `stripVerificationPreamble`
(`preflight-rules.ts:169` — fence-aware, testuota
`src/tests/quality-gates-preflight.test.ts:455-479`; jokio naujo parserio).
Alternatyva „valyti tik requeue komandoje" atmesta: išėjimų iš lango yra
daug (koordinatoriaus finish, CLI requeue/task-move, HTTP triažas) —
taisyklė gyvena viename perėjimo taške, bucket-transition. Grep radinys
2026-08-30: `src/interfaces/http/ui-task-actions.ts:205` triažo perkėlimą
daro TIESIAI per `ports.store.moveTaskState`, aplenkdamas
`moveTaskToBucket` — be jo pataisos HTTP requeue liktų invarianto spraga.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/bucket-transition.ts`
- `src/infrastructure/state/task-state-store.ts` (porto praplėtimo
  realizacija — skaitymas/rašymas teksto)
- `src/interfaces/http/ui-task-actions.ts` (205 eil. bypass nukreipimas per
  `moveTaskToBucket`)
- `src/tests/task-execution-rules.test.ts` (esami bucket-transition testai,
  408-433 eil., ir port fake 411 eil.)
- `src/tests/infrastructure-task-state-store.test.ts`
- `src/tests/interfaces-http-task-actions.test.ts` (port fake 156-161 eil.)
- `src/tests/interfaces-cli-task-queue.test.ts` (port fake 70-80 eil.;
  requeue strip integracijos testas)
- `src/tests/composition-wave-integration-adapters.test.ts` (port fake
  19-28 eil.)
- `src/tests/task-execution-bucket-transition.test.ts` (numatomas naujas:
  `task-execution-rules.test.ts` jau 434 eil. ir nauji testai gali kirsti
  500 eil. vartą; jei telpa esamame — naujo nekurti, įrašyti į ataskaitą)
- `src/composition/runtime/node-adapters.ts` (2026-08-30 implementacijos
  radinys: `moveToHumanReview` blocked-task maršrutizavime ėjo tiesiai per
  `store.moveTaskState` — trečias chokepoint'o apėjimas šalia HTTP triažo;
  nukreiptas per `moveTaskToBucket`)

Draudžiama:
- `src/interfaces/hooks/**` (093 scope)
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (093 scope)
- `src/application/quality-gates/preflight-rules.ts` (tik importuojamas,
  nekeičiamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/application/task-execution/bucket-transition.ts`: `moveTaskToBucket`
  ir `finishTaskInBucket` — kai TIKSLO bucket'as nėra `active`/`delegated`,
  prieš move perskaityti šaltinio turinį, pravaryti per
  `stripVerificationPreamble` (importas iš
  `../quality-gates/preflight-rules.js` — application → application
  leidžiama) ir, jei pasikeitė, įrašyti atgal, tada move. Dėmesio:
  `failed` adapteryje normalizuojasi į `human-review`
  (`src/domain/tasks/buckets.ts:46`) — strip taikomas ir jam.
- Skaitymo/rašymo galimybė — per `TaskStateStorePort` praplėtimą (pvz.
  `readTaskText`/`writeTaskText`), realizacija `createTaskStateStore`
  (`src/infrastructure/state/task-state-store.ts`). Kompozicijos kvietėjai
  (`coordinator-adapters.ts:129-131`, `empty-queue-adapters.ts:127`,
  `wave-integration-adapters.ts:134`, `commands-tasks.ts:56,68`,
  `commands-ops.ts:277`) paduoda realų store iš `createTaskStateStore`, tad
  jų keisti nereikia; porto fake'ai deklaruotuose testų failuose gauna
  naujus metodus.
- `src/interfaces/http/ui-task-actions.ts:205`: perkėlimą nukreipti per
  `moveTaskToBucket`, kad HTTP triažo requeue kelias human-review → queue
  taip pat išlaikytų invariantą.
- Requeue (`interfaces/cli/task-queue/requeue.ts`) elgesį gauna nemokamai
  per `moveTaskToBucket` — kodo keisti nereikia, tik integracijos testas.
- Testų lūkesčiai: (1) perkėlimas active → human-review nuima preambulę;
  (2) queue → active turinio nekeičia; (3) kanoninis turinys be preambulės
  grįžta baitas-į-baitą ir papildomo rašymo nėra; (4) fence bloke cituojama
  `## Žingsnis 0` antraštė nepaliečiama (strip tą jau garantuoja — testas
  patvirtina integraciją); (5) HTTP triažo requeue perkeltas failas queue
  bucket'e jau be preambulės.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei porto praplėtimas
verstų keisti failus už deklaruoto sąrašo ribų (pvz. atsirastų dar vienas
`TaskStateStorePort` fake'as, kurio Grep nerado).

## Neįtraukta
Dispatch'o delivery mechanizmo keitimas — bucket failas lieka prompt'o
vehiklu, `installReformulatedTask` elgesys nekeičiamas. Human-review/done
bucket'uose JAU gulinčių senų dispatch-formos failų valymas — vienkartinis
operatoriaus veiksmas, ne šio kodo kelio darbas. Vartų pusė (pre-write
hook'as ir konformance testas atpažįsta dispatch'o formą active/delegated
bucket'uose) — 093.
