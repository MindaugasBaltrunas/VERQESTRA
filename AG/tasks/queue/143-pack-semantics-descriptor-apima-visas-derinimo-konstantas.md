# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 128-arrest-markerio-skaitymo-luzis-nebevirsta-tyliu-resetu

Priklausomybė nuo 128 yra realus failų persidengimas, ne atsargumas: 128
`## Failai` Leidžiama turi `src/tests/context-pack-guards.test.ts`
(spillover po 2026-09-01 parkavimosi), o šis task'as perrašo to paties
failo deskriptoriaus pin'ą 201-209 eil.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/context-pack/context-cache-key.ts`
`PACK_SEMANTICS_DESCRIPTOR` (dabar 49-63 eil.) jau turi
`min_architecture_token_length`, `spec_drop_refs_listed`, `warning_severity`
ir `score_precision` eilutes — ALREADY_IMPLEMENTED: cituok deskriptoriaus
eilutes ir atnaujintą `src/tests/context-pack-guards.test.ts` pin'ą
(dabar 201-209 eil.) kaip įrodymą.

## Tikslas
RAG auditas 7 (2026-09-01), P2 + trys P3 tos pačios klasės kaip audito 4
pamirštas `IMPACTED_TEST_IMPORTER_DEPTH` (žr. `context-cache-key.ts` 57-61
eil. komentarą): pack'o turinį formuojančios derinimo konstantos NĖRA
`PACK_SEMANTICS_DESCRIPTOR`, tad jų pakeitimas negrąžina cache miss — senas
įrašas grįžta kaip `hit` ir tyliai anuliuoja derinimą:

1. (P2) `src/application/context-pack/assemble/gather.ts:206`
   `MIN_ARCHITECTURE_TOKEN_LENGTH = 3` — lemia, kurie architektūros mazgai
   patenka į pack'ą (`matchArchitectureNodes`).
2. (P3) `src/application/context-pack/assemble/spec-phase.ts:82`
   `SPEC_DROP_REFS_LISTED = 5` — kiek numestų ref'ų įvardijama
   `specSelectionDropWarning` eilutėje, t. y. pack'o
   `spec_fragment_warnings` turinys.
3. (P3) `spec-phase.ts:43-56` `WARNING_SEVERITY` lentelė — įspėjimų lubų
   taikymo TVARKA, t. y. kurios eilutės išgyvena
   `capSpecRetrievalWarnings`.
4. (P3) `src/application/code-intelligence/retrieval/ranking.ts:74`
   `SCORE_PRECISION = 6` — apvalinimas prieš rūšiavimą, t. y. kandidatų
   tvarka pakopos viduje.

Deskriptoriaus visa prasmė — kad derinimo konstantos į raktą patektų BE
atskiro prisiminimo; kiekviena jame nesanti konstanta yra spraga pačiame
mechanizme. `CONTEXT_CACHE_VERSION` kelti NEREIKIA (atmesta alternatyva):
deskriptorius hash'uojamas į fingerprint'ą (`computeContextCacheKey`,
79-85 eil.), tad jo pakeitimas senus įrašus invaliduoja automatiškai —
versija yra rankinis kontraktas TIK loginiams pakeitimams, kurių čia nėra.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/context-cache-key.ts`
- `src/application/context-pack/assemble/gather.ts` (TIK
  `MIN_ARCHITECTURE_TOKEN_LENGTH` eksportas — dabar failo vidinis `const`)
- `src/application/context-pack/assemble/spec-phase.ts` (TIK
  `WARNING_SEVERITY` ir `SPEC_DROP_REFS_LISTED` eksportai — dabar failo
  vidiniai `const`)
- `src/application/code-intelligence/retrieval/ranking.ts` (TIK
  `SCORE_PRECISION` eksportas — dabar failo vidinis `const`)
- `src/tests/context-pack-guards.test.ts` (deskriptoriaus pin'as
  201-209 eil. ir jo komentaras 183-194 eil.)

Draudžiama:
- `src/application/context-pack/context-cache-model.ts`
  (`CONTEXT_CACHE_VERSION` šiam pakeitimui NEKELIAMA — žr. Tikslas; failas
  yra 101/138/144 scope)
- `src/tests/context-pack.test.ts` (128 scope)
- `src/tests/context-pack-rag-audit-4.test.ts` (144 scope; jo
  deskriptoriaus patikra 201-202 eil. yra `includes` — naujos eilutės jos
  nelaužo)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Eksportuoti keturias konstantas iš jų namų failų (kopijų NEkurti —
  deskriptorius importuoja, kaip jau daro su `MAX_SPEC_RETRIEVAL_WARNINGS`
  iš to paties `spec-phase.ts` ir `RETRIEVAL_PRIORITY_ORDER` iš
  `ranking.ts`).
- `context-cache-key.ts` `PACK_SEMANTICS_DESCRIPTOR`: pridėti keturias
  eilutes su komentaru kodėl (pagal esamą `impacted_test_importer_depth`
  pavyzdį). `WARNING_SEVERITY` serializuoti DETERMINISTIŠKAI (fiksuota
  raktų tvarka, ne `Object.keys` iteracija be garantijos formuluotėje —
  raktas privalo būti baitas į baitą stabilus tarp procesų).
- DĖMESIO ciklams: `context-cache-key.ts` gaus naują importą iš
  `assemble/gather.ts`. Grep 2026-09-01: `gather.ts` `context-cache-key`
  neimportuoja (importų sąrašas 6-14 eil.), tad ciklo būti neturėtų — bet
  architektūros vartas (`architecture-gates.test.ts`, aciklinis grafas) yra
  teisėjas; jei praneša ciklą, konstantą kelti į atskirą eksportuojamą
  vietą, ne kopijuoti.
- `src/tests/context-pack-guards.test.ts` 201-209 eil.: pilnos
  deskriptoriaus eilutės pin'as perrašomas su naujomis dalimis; komentaras
  183-194 eil. papildomas, jei formuluotė nebeatitinka.
- Testų lūkestis: (1) deskriptoriaus pin'as tikslus su visomis keturiomis
  naujomis dalimis; (2) fingerprint'as keičiasi pakeitus deskriptorių
  (esamas „ne dekoracija" assert'as 216-219 eil. lieka žalias).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei architektūros vartas
parodytų importo ciklą, kurio neišsprendžia konstantos iškėlimas šio
task'o failų ribose.

## Neįtraukta
- `CONTEXT_CACHE_VERSION` kėlimas — nereikalingas (deskriptorius rakte
  dalyvauja per hash; pagrindimas Tiksle).
- `BM25_K1`/`BM25_B` (`ranking.ts:69-70`) įtraukimas į deskriptorių — ta
  pati klasė, bet audito 7 radinys jų neįvardijo; fiksuoti ataskaitoje
  kaip kandidatą atskiram sprendimui, ne plėsti scope tyliai.
- Spec dedup/atribucijos taisymai tame pačiame `spec-phase.ts` — 144
  scope (jis priklauso nuo šio task'o dėl bendrų failų).
