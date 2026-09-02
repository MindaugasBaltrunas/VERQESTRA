# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 144-spec-dedup-nebemaskuoja-biudzeto-praradimu-atribucija-teisinga

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/code-intelligence/retrieval/spec-fragments.ts`
`applySpecFragmentBudget` dublikatą klasifikuoja pagal NEKIRPTĄ turinį ir PO
biudžeto patikros (t. y. `seen.add` nebevyksta prieš `char_budget`/
`fragment_limit` patikras), o `retrieveSpecFragmentCandidates` identiškus
ref'us skaito vieną kartą — ALREADY_IMPLEMENTED: cituok abi vietas ir
testus kaip įrodymą. Dalinio darbo rizika: du nepriklausomi taisymai —
tikrinti po punktą.

## Tikslas
RAG auditas 7 (2026-09-01), radiniai R1 (P2) ir R3 (P3). `spec-fragments.ts`
`applySpecFragmentBudget` (dabar 212-268 eil.) dedup raktas yra
`fragment.text` — fazėje 1 JAU apkirptas iki `specCharBudget` tekstas — ir
`seen.add` įvyksta PRIEŠ fragment_limit/char_budget patikras (241-248 eil.).
Prie nulinio spec biudžeto (task tekstas ≥ `max_context_chars`) fazė 1
visus fragmentus apkerpa į `""`: pirmas gauna `char_budget`, o VISI likę —
`duplicate reference in the task` su severity `redundant`, kurio
dokumentuota prasmė yra „nieko neprarasta". Operatorius mato task'o rašybos
defektą ten, kur realiai išseko biudžetas. Fazė 1
(`retrieveSpecFragmentCandidates`, 158-205 eil.) ref'ų nededupina prieš
skaitymą: tas pats ref du kartus = dvigubas IO ir dvi identiškos `spec
source not found` eilutės, valgančios `MAX_SPEC_RETRIEVAL_WARNINGS = 10`
lubas.

Audito 4 invariantas IŠLIEKA (žr. komentarą 224-234 eil.): tikras
dublikatas — du skirtingai užrašyti ref'ai su tuo pačiu pilnu turiniu —
biudžeto dukart nevalgo ir pranešamas `redundant`.

Kilmė: 144 skėlimas (2026-09-02). 144-a dalis (`droppedCount` be `duplicate`,
`CONTEXT_CACHE_VERSION` 12) jau main'e; čia — likusi dedup klasifikacija.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/code-intelligence/retrieval/spec-fragments.ts`
- `src/tests/code-intelligence.test.ts`
- `src/tests/context-pack-rag-audit-4.test.ts`

Draudžiama:
- `src/application/context-pack/assemble/spec-phase.ts` (144-a scope)
- `src/application/context-pack/context-cache-model.ts` (versijos NEKELTI:
  12 jau apima šią grandinę — `spec_fragment_warnings` turinys tam pačiam
  task'ui keičiasi, bet kėlimas įvyko su 144-a)
- `src/tests/context-pack-guards.test.ts` (versijos pin'as — 144-a scope)
- `src/tests/context-pack-code-index-identity.test.ts` (versijos pin'as)
- `src/tests/context-pack-assemble.test.ts` (101 scope)
- `src/application/code-intelligence/retrieval/ranking.ts` (reitingavimas
  nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `applySpecFragmentBudget`: dublikato tapatybė — NEKIRPTAS fazės 1 turinys
  (jei pilno teksto fazė 2 neturi, nešk jo hash'ą ant `RetrievedFragment`
  iš fazės 1; forma — vykdytojo sprendimas), o `duplicate` verdiktas
  skiriamas TIK kai pirmasis egzempliorius realiai pateko į `kept`; kitu
  atveju numetimas gauna tikrąją priežastį (`char_budget`/`fragment_limit`).
  Dedup ir toliau vyksta PRIEŠ biudžeto IŠLEIDIMĄ tikram dublikatui —
  audito 4 taisymas neatšaukiamas.
- `retrieveSpecFragmentCandidates`: identiški ref'ai (po `trim`) skaitomi
  vieną kartą — vienas IO, viena `unresolved` / fragmento eilutė; kandidatų
  limito (`considered`) dublikatas nevalgo.
- Testų lūkestis: (1) išsekęs/nulinis biudžetas su keliais SKIRTINGAIS
  ref'ais → visi numetimai `char_budget`, nė vieno `duplicate`; (2) tikras
  dublikatas (skirtingi ref'ai, tas pats pilnas turinys, pirmas kept) →
  antras `duplicate`, biudžetas išleistas kartą (perrašyk
  `context-pack-rag-audit-4.test.ts` 32-46 eil. atvejį pagal naują
  klasifikaciją, invariantas išlieka); (3) tas pats neegzistuojantis ref du
  kartus → VIENA `spec source not found` eilutė.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei nekirpto turinio
tapatybei reikėtų keisti `RetrievedFragment` formą taip, kad ji pasklistų
už šio task'o failų (pvz. į `context-pack-schema.ts`).

## Neįtraukta
- `droppedCount` metrika ir `CONTEXT_CACHE_VERSION` — atlikta 144-a.
- `MAX_SPEC_RETRIEVAL_WARNINGS` lubų dydis ir `WARNING_SEVERITY` tvarka —
  nekvestionuojami; čia taisoma tik klasifikacija.
