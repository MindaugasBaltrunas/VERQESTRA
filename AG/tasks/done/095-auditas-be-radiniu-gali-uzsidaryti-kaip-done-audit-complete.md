# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Sėkmingas auditas, kuris nieko taisytino neranda, šiandien negali užsidaryti kaip done: commit'o nėra, o ALREADY_IMPLEMENTED jo deliverable (ataskaita) semantiškai neatitinka. Įvesti domain lygio `AUDIT_COMPLETE` markerio atpažinimą ir TREČIĄ siaurą no-commit done šaką su dvigubu įrodymu. Šis task'as yra tik `src/domain/diagnosis` + jo testai; port'ų ir adapterių prijungimas — atskiri nuoseklūs task'ai.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/diagnosis/stream-log.ts`
- `src/domain/diagnosis/dispositions.ts`
- `src/tests/domain-diagnosis-audit-complete.test.ts`
- `src/tests/domain-diagnosis-already-implemented.test.ts`
- `src/tests/quality-gates-verify.test.ts`
- `src/tests/fixtures/characterization/diagnosis-dispositions.json`
- `src/tests/characterization-diagnosis.test.ts`

Draudžiama:
- `src/application`
- `src/composition`
- `src/interfaces`
- `AG/tasks/examples/000-etalonas.md`
- `ui-app`
- `dist`
- `node_modules`

## Veiksmas
- `src/domain/diagnosis/stream-log.ts`: greta `logHasAlreadyImplementedMarker` (40-46 eil.) pridėk `logHasAuditCompleteMarker` ta pačia dviguba paieška (žalias log'as IR `extractResultEnvelopeFromStreamJsonLog` result laukas — stream-json pamoka 1048/1049); forma `AUDIT_COMPLETE: <santrauka>` privalo būti atpažįstama.
- `src/domain/diagnosis/dispositions.ts`: `NoCommitDoneInputs` (~203 eil.) naujas neprivalomas laukas audito markeriui; `resolveNoCommitDisposition` (246-269 eil.) trečia siaura šaka — audito markeris IR `writeActivity === "no-writes"` IR `productDirtyCount === 0` → `"done"`; visais kitais atvejais (`"unknown"`, `"wrote"`, dirty medis, laukas nepaduotas) elgesys NEKINTA; `resolveNoCommitReviewReason` gauna tikslesnę eilutę atvejui „audito markeris yra, bet no-writes nepatvirtintas“.
- Testai: markerio atpažinimo atvejai (plain-text, stream-json envelope, neigiami) ir disposition atvejai abiem kryptimis; characterization fixture papildyti NAUJAIS įrašais nekeičiant nė vieno esamo verdikto.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Stabdyk ir klausk, jei architektas nusprendžia keisti kryptį A (markeris kode) į B (auditas commit'ina ataskaitą į repo failą), jei sprendimas reikalautų silpninti esamus already-implemented testus ar keisti esamus fixture verdiktus, arba jei šaka reikalautų prieigos už `src/domain/diagnosis` ribų. Baigęs su žalia `pnpm test` — commit'ink ir sustok.

## Neįtraukta
- `DiagnosisRulesPort` metodas ir `verify-task` prijungimas (`src/application`) — kitas task'as.
- Kanoninės implementacijos prijungimas adapteryje (`src/composition`) — trečias task'as.
- Task'ų šablono keitimas (kryptis B) — ne šiame kelyje.
