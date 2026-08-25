# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md (režimas R2, įrodymas A)

## Tikslas
Uždaryti R2 iš 020 diagnozės: kai Stop hook'o commit'as neįvyksta iki dispatch pabaigos,
task-scoped rollback'as sunaikina ledger'io MATOMĄ necommit'intą darbą (018 atvejis: „restored
2 task path(s)" — abu keliai buvo ledger'yje, darbas teisingas, patikros žalios). Necommit'intas,
bet ledger'io matomas nuosavas darbas privalo būti IŠSAUGOTAS, ne revertintas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/infrastructure/git/rollback-scope.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- ĮRODYMŲ SEKA (visa — audito dokumente): CLAUDE FINISHED 13:57:18 → vaiko STOP įvykis tik
  13:57:42 (24 s PO proceso pabaigos — orkestratorius kontrolę perima anksčiau, nei hook'ai
  baigia) → diagnosis verdict=done (patikros žalios) → ROLLBACK TASK-SCOPED restored 2 →
  „Claude did not create a new commit" → teisingas darbas sunaikintas.
- SPRENDIMO KRYPTYS (architect renkasi, pagrindžia; kryptis SIAURINANTI — jokio fail-open):
  1. verify kelias PRIEŠ rollback'ą necommit'intą ledger'io matomą nuosavą darbą IŠSAUGO
     (pvz. snapshot commit'as žymėtu branch'u arba stash su task žyma) ir human-review
     priežastyje nurodo, KUR darbas guli — operatorius sprendžia turėdamas darbą, ne jo vietą;
  2. dispatch pabaiga LAUKIA stop-bridge įrodymo ribotą langą (bounded poll) prieš verify —
     24 s lenktynė tarp proceso exit ir Stop hook'o pabaigos išnyksta;
  3. abi kartu (laukimas + išsaugojimas kaip antras diržas).
- Pasirinktą elgesį padengti regresiniu testu, atkuriančiu 018 seką: ledger'yje 2 nuosavi
  keliai, commit'o nėra, diagnosis done → darbas NEPRARANDAMAS (išsaugotas arba sulauktas).
- `git diff --check` švarus; jokių naujų fail-open kelių.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų keisti
stop-bridge kontraktą (`infrastructure/state/stop-bridge`) — tai atskiro patvirtinimo riba.

## Neįtraukta
- R1 (jau uždaryta 020-a-02 fallback'u).
- `hook-post-bash` praplėtimas iki darbo ledger'io (atviras klausimas, operatoriaus riba).
- LLM kvietimai, queue loop vykdymas.
