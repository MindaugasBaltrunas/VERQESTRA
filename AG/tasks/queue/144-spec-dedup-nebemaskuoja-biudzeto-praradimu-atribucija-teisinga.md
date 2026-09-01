# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 143-pack-semantics-descriptor-apima-visas-derinimo-konstantas
- 138-agentu-grandines-parseris-nebedaro-cipu-is-prozos-zodziu
- 101-discovered-docs-prijungti-su-cache-tapatybe-arba-pasalinti

Visos trys priklausomybės — realūs failų persidengimai, ne atsargumas:
143 dalijasi `spec-phase.ts` (eksportai) ir `context-pack-guards.test.ts`
(deskriptoriaus pin'as greta versijos pin'o); 138 ir 101 abu deklaruoja
`context-cache-model.ts` (`CONTEXT_CACHE_VERSION` kėlimas su istorija) —
138 pats priklauso nuo 101 dėl tos pačios eilutės, tad šis task'as
rikiuojasi grandinės gale.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/code-intelligence/retrieval/spec-fragments.ts`
`applySpecFragmentBudget` (dabar 212-268 eil.) dublikatą klasifikuoja pagal
NEKIRPTĄ turinį ir PO biudžeto klasifikacijos (t. y. `seen.add` nebevyksta
223-239 eil. formos cikle prieš `char_budget` patikrą), o
`src/application/context-pack/assemble/spec-phase.ts` `droppedCount`
(dabar 186 eil.) `duplicate` numetimų nebeskaičiuoja — ALREADY_IMPLEMENTED:
cituok abi vietas ir testus kaip įrodymą. Dalinio darbo rizika: trys
nepriklausomi taisymai — tikrinti po punktą.

## Tikslas
RAG auditas 7 (2026-09-01), spec biudžeto/dedup atribucijos defektai:

1. (P2/R1) `spec-fragments.ts:235-239`: dedup raktas yra `fragment.text` —
   fazėje 1 JAU apkirptas iki `specCharBudget` tekstas — ir `seen.add`
   įvyksta PRIEŠ fragment_limit/char_budget patikras (241-248 eil.). Prie
   nulinio spec biudžeto (task tekstas ≥ `max_context_chars`) fazė 1 visus
   fragmentus apkerpа į `""`: pirmas gauna `char_budget`, o VISI likę —
   `duplicate reference in the task` su severity `redundant`, kurio
   dokumentuota prasmė (`spec-phase.ts:52-53`) yra „nieko neprarasta".
   Operatorius mato task'o rašybos defektą ten, kur realiai išseko
   biudžetas.
2. (P3/R2) `spec-phase.ts:186` `droppedCount` sumuoja ir `duplicate`
   numetimus, nors lauko dok. (77 eil.) sako „PRARASTŲ ref'ų skaičius" —
   dublikatas pagal apibrėžimą praradimas nėra; metrika
   (`spec_dropped_count`) perdeda.
3. (P3/R3) fazė 1 (`retrieveSpecFragmentCandidates`,
   `spec-fragments.ts:158-205`) ref'ų nededupina prieš skaitymą: tas pats
   ref du kartus = dvigubas IO ir dvi identiškos `spec source not found`
   eilutės, valgančios `MAX_SPEC_RETRIEVAL_WARNINGS = 10` lubas.

Kryptis: dedup pagal nekirptą turinį (arba ref+turinio porą) PO biudžeto
klasifikacijos, `duplicate` neskaičiuojamas kaip praradimas, identiški
ref'ai dedupinami fazėje 1. Audito 4 invariantas IŠLIEKA (žr. komentarą
224-234 eil.): tikras dublikatas — du skirtingai užrašyti ref'ai su tuo
pačiu pilnu turiniu — biudžeto dukart nevalgo ir pranešamas `redundant`.
Elgesys keičia pack'o turinį (`spec_fragment_warnings`,
`spec_dropped_count`, kas išgyvena biudžetą), tad pagal CLAUDE.md „Pack'o
semantika ir kešas" `CONTEXT_CACHE_VERSION` KELIAMA 10 → 11.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/code-intelligence/retrieval/spec-fragments.ts`
- `src/application/context-pack/assemble/spec-phase.ts`
- `src/application/context-pack/context-cache-model.ts` (TIK
  `CONTEXT_CACHE_VERSION` 10 → 11 su istorijos įrašu „11 — …")
- `src/tests/code-intelligence.test.ts` (`applySpecFragmentBudget` /
  `retrieveSpecFragmentCandidates` atvejai gyvena čia — Grep 2026-09-01:
  16 atitikmenų)
- `src/tests/context-pack-rag-audit-4.test.ts` (dedup pagal turinį testas
  32-46 eil. — perrašomas pagal naują klasifikaciją, invariantas išlieka)
- `src/tests/context-pack-guards.test.ts` (TIK versijos pin'as 196-200
  eil. — „pakelta vienuoliktą kartą: …")

Draudžiama:
- `src/tests/context-pack-assemble.test.ts` (101 scope; jo
  `spec_dropped_count` testas 159-199 eil. naudoja DU SKIRTINGUS
  neegzistuojančius ref'us — fazės 1 dedup jo nepaveikia)
- `src/application/context-pack/context-cache-key.ts` (143 scope)
- `src/application/code-intelligence/retrieval/ranking.ts` (reitingavimas
  nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `spec-fragments.ts` `applySpecFragmentBudget`: dublikato tapatybė —
  NEKIRPTAS fazės 1 turinys (jei pilno teksto fazė 2 neturi — nešti jo
  hash'ą ant `RetrievedFragment` iš fazės 1; forma — vykdytojo sprendimas),
  o `duplicate` verdiktas skiriamas TIK kai pirmasis egzempliorius realiai
  pateko į `kept`; biudžeto/limito numetimas gauna tikrąją priežastį
  (`char_budget`/`fragment_limit`). Dedup ir toliau įvyksta PRIEŠ biudžeto
  IŠLEIDIMĄ tikram dublikatui — audito 4 taisymas (dvigubos išlaidos)
  neatšaukiamas.
- `spec-phase.ts`: `droppedCount` (186 eil.) skaičiuoja
  `unresolved + dropped BE duplicate`; dok. 77 eil. lieka teisingas be
  perrašymo.
- `spec-fragments.ts` `retrieveSpecFragmentCandidates`: identiški ref'ai
  (po `trim`) skaitomi vieną kartą — vienas IO, viena `unresolved` /
  fragmento eilutė; kandidatų limito (`considered`) dublikatas nevalgo.
- `context-cache-model.ts`: versija 11 su istorijos įrašu — kodėl senas
  įrašas meluotų (kitos `spec_fragment_warnings` eilutės ir
  `spec_dropped_count` tam pačiam task'ui).
- Testų lūkestis: (1) išsekęs/nulinis biudžetas su keliais SKIRTINGAIS
  ref'ais → visi numetimai `char_budget`, nė vieno `duplicate`;
  (2) tikras dublikatas (skirtingi ref'ai, tas pats pilnas turinys,
  pirmas kept) → antras `duplicate`, biudžetas išleistas kartą;
  (3) `droppedCount`/`spec_dropped_count` be dublikatų; (4) tas pats
  neegzistuojantis ref du kartus → VIENA `spec source not found` eilutė;
  (5) guards versijos pin'as 11.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
nekirpto turinio tapatybei reikia keisti `RetrievedFragment` formą taip,
kad ji pasklistų už šio task'o failų (pvz. į `context-pack-schema.ts`).

## Neįtraukta
- `MAX_SPEC_RETRIEVAL_WARNINGS` lubų dydis ir `WARNING_SEVERITY` tvarka —
  nekvestionuojami; čia taisoma tik klasifikacija, ne lubos (severity
  eksportai — 143 scope).
- `context-pack-assemble.test.ts` `spec_dropped_count` atvejis — jo ref'ai
  skirtingi, elgesys jam nesikeičia; jei vis dėlto paraudonuotų, tai
  scope konfliktas su 101 — stop ir klausk, ne tylus pridėjimas.
- Fazės 1 per-fragmento kirpimo strategija (kiekvienas atskirai iki viso
  biudžeto) — dokumentuotas dviejų fazių dizainas (spec-phase.ts 5-11
  eil.) lieka.
