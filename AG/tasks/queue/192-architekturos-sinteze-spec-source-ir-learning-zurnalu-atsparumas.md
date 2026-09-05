# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Tikrinti po punktą: (1) `src/application/architecture/task-synthesizer.ts:134-138` sintezuoto task'o
`## Spec source` neša OpenSpec nuorodą (arba `architecture-node/<id>` forma pripažįstama
`preflight.ts:116-118` `specSourceExists`), o `## Patikra` iš `contract.checks` normalizuojama į
backtick formą; (2) `src/application/architecture/evidence-ledger.ts:24,41` `JSON.parse` sugadintą
eilutę praleidžia su įspėjimu; (3) `src/application/learning/learning-memory.ts:127-133`
`summarizeLearningMemory` dublikatus tuo pačiu id skaičiuoja vieną kartą. Visi — ALREADY_IMPLEMENTED
su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Application; `audit-application.md`
AR-1, AR-2, AN-1).
- AR-1 `architecture/wave.ts:270` + `task-synthesizer.ts:134-138` — wave sintezuoti task'ai neša
  `## Spec source` `architecture-node/<id> (run: …)` be OpenSpec nuorodos; `preflight.ts:116-118`
  `specSourceExists` → „spec source not found" → manual preflight `invalid`. Loop kelias išgyvena tik
  per `autoOpenSpec` (šablone `true`). `## Patikra` iš `contract.checks` (pvz. `npm run test`) →
  etalonas `patikra-unknown-command`. Queue-synth kelias (`specSource` paduodamas) šios spragos neturi.
  Kryptis: wave kelias paduoda `specSource` taip pat kaip queue-synth (change katalogas, kurį
  `autoOpenSpec` sukuria arba kurį paduoda kvietėjas), o `architecture-node/<id>` lieka antra
  eilute kaip anotacija; `## Patikra` — visada etalono forma (`pnpm build`, `pnpm test`), o
  `contract.checks` keliauja į `## Veiksmas` kaip tekstas.
- AR-2 `evidence-ledger.ts:24,41` `JSON.parse` be `try` — viena sugadinta `evidence.jsonl` eilutė
  nuverčia visą wave/queue-synth. Kryptis: sugadintos eilutės praleidžiamos ir suskaičiuojamos
  (kaip `token-usage` skaitytojai), ne meta.
- AN-1 `learning-memory.ts:127-133` `summarizeLearningMemory.records/by_type` skaičiuoja kiekvieną
  append'intą eilutę, įskaitant `decideLearningRecommendation` dublikatus tuo pačiu id. Kryptis:
  suvestinė dedup'ina pagal id (paskutinis įrašas laimi), kaip UI jau rodo.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/architecture/wave.ts` (270 eil. spec source ir checks perdavimas)
- `src/application/architecture/task-synthesizer.ts` (134-138 eil.)
- `src/application/architecture/evidence-ledger.ts` (24, 41 eil.)
- `src/application/learning/learning-memory.ts` (127-133 eil.)
- `src/tests/application-architecture-wave.test.ts`
- `src/tests/application-architecture.test.ts`
- `src/tests/learning-memory.test.ts`

Draudžiama:
- `src/application/project-bootstrap/queue-synth.ts` (teisingas kelias — pavyzdys, nekinta)
- `src/application/quality-gates/preflight.ts` (`specSourceExists` — task 183 scope, nekinta)
- `src/domain/tasks/etalonas-rules.ts` (task 181)
- `src/interfaces/**`
- `src/composition/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `task-synthesizer.ts`/`wave.ts`: `SynthesisInput` gauna `specSource` (kaip queue-synth); wave
  kelias jį užpildo; `## Patikra` = etalono dvi komandos; `contract.checks` → `## Veiksmas` bullet
  „Kontrakto patikros: …". Sintezuotas tekstas praeina `validateTaskAgainstEtalonas` (testas tai
  tvirtina tiesiogiai — importas iš `domain/tasks/etalonas-rules.js` teste leidžiamas).
- `evidence-ledger.ts`: `parseJsonlLine` su `try`, sugadintų eilučių skaitiklis grąžinamas
  kvietėjui; testas su viena sugadinta eilute tarp dviejų gerų.
- `learning-memory.ts`: suvestinė per `Map<id, record>`; testas — du įrašai tuo pačiu id → `records: 1`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `SynthesisInput` kontrakto praplėtimas
reikalauja keisti `interfaces-cli-bootstrap-project.test.ts` ar `bootstrap-queue-synth.test.ts`
(importuoja tipą; ne šio scope) — tada laukas privalo būti neprivalomas su senu elgesiu.

## Neįtraukta
- PG-4, PG-5, SD-1, RR-1 — task 191.
- `autoOpenSpec` šablono reikšmė ir OpenSpec change kūrimo politika — nekinta.
- `wave-reclaim.ts`, `governance.ts`, `node-verifier.ts` — auditas: švaru.
