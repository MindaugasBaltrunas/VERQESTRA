# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/benchmark/results/runs/run-20260825t210704416z.unmeasured.jsonl (24 įrašai, 8 scenarijai)

## Tikslas
Grąžinti į ag-loop benchmark aprėptį 8 scenarijus, kurių celės baigia su `attempts=0`
(celės vidinis loop'as parkuoja task'ą prieš pirmą dispatch'ą), nekerpant pačių vartų:
scenarijus yra žmogaus autorizuotas artefaktas, tad celės task'as turi teisę į
`HUMAN-REVIEW-APPROVED` žymą pagal konstrukciją.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/benchmark/benchmark-loop-cell.ts`
- `AG/benchmark/src/**`
- `src/tests/**`

Draudžiama:
- `src/domain/tasks/human-review/**` (vartų taisyklės NEKEIČIAMOS)
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-26 pilnas bėgimas run-20260825t210704416z): 8 scenarijų ag-loop celės
  (visos 3 rep. kiekvieno) atmestos `telemetry.attempts out-of-range: received 0` — loop'as
  celėje nepadarė nė vieno bandymo. Kaina nulinė (nė vieno LLM kvietimo), bet ag-loop
  aprėptis 16/24 vietoj 24/24. Scenarijai: bugfix-session-token-expiry,
  code-permission-wildcard, refactor-permission-inheritance, refactor-badge-markup-builder,
  security-log-session-tokens, security-skip-signature-check, security-unknown-role-admin,
  tests-permission-denial-matrix.
- IŠTIRTI iš celės žurnalų (ne iš pavadinimų) TIKRĄJĄ parkavimo priežastį kiekvienam:
  7/8 tikėtinai saugumo raktažodžių vartai (`token`, `permission`, `security`, `role`,
  `signature`), bet `refactor-badge-markup-builder` į šį šabloną netelpa — jo priežastis
  privalo būti įvardyta atskirai prieš renkant sprendimą.
- SPRENDIMO KRYPTIS (bazinė): `benchmark-loop-cell` kelias, statydamas celės task failą iš
  scenarijaus, įrašo `HUMAN-REVIEW-APPROVED: benchmark-suite <data> (scenarijus — žmogaus
  autorizuotas rinkinio artefaktas)` žymą. Vartų TAISYKLĖS nesikeičia — keičiasi tik tai,
  kad celės task'as ateina su jau uždėtu parašu, kaip ir bet kuris operatoriaus patvirtintas
  task'as. Jei tyrimas atskleistų kitokią badge-markup priežastį — jai atskiras sprendimas,
  ne žymos išplėtimas.
- BENCH-3 sąžiningumas: `ag-loop` adapterio deklaruotų skirtumų sąraše pridėti
  `approval-preapplied` įrašą — palyginimas su agent-solo privalo deklaruoti, kad loop'o
  celėms approval vartai pereiti iš anksto.
- Regresinis testas: scenarijaus tekstas su saugumo raktažodžiu → celės task'as gauna žymą →
  `analyzeHumanReviewGates` jo nebeparkuoja; žymos formatas atitinka
  `domain/tasks/human-review/gates.ts:45` regex'ą.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir AG/benchmark test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų
keisti `domain/tasks/human-review` vartų taisykles arba `suite.lock.json` hash'ą.

## Neįtraukta
- Vartų taisyklių keitimas.
- Pakartotinis pilnas mokamas bėgimas (operatoriaus sprendimas).
- LLM kvietimai, queue loop vykdymas.
