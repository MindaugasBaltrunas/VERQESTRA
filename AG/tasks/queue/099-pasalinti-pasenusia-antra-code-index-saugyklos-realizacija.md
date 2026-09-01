# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/infrastructure/persistence/code-index-store.ts` nebeegzistuoja (Glob),
`src/infrastructure/index.ts` nebeturi eilutės
`export * from "./persistence/code-index-store.js"`, o
`src/tests/infrastructure-persistence.test.ts` nebeimportuoja
`infrastructure/persistence/code-index-store` — ALREADY_IMPLEMENTED: cituok
Glob/Grep rezultatus kaip įrodymą.

## Tikslas
Repo turi ANTRĄ, pasenusią code-index saugyklos realizaciją
`src/infrastructure/persistence/code-index-store.ts` (patikrinta 2026-09-01):
jos `checkCodeIndexFreshness` (53-80 eil.) tikrina TIK `version` ir
`source_hash` — jokio `records_hash` tikrinimo, kurį kanoninė realizacija
`src/application/code-intelligence/store/code-index-store.ts` atlieka 146-147
eil. (`computeRecordsHash` prieš `currentManifest.records_hash`). Operatoriaus
reprodukcija (2026-09-01): pakeitus `edges.jsonl` turinį, kanoninė saugykla
grąžino corrupt, o infra kopija — `ok: true`. Visa produkcija
(`indexing/builder.ts`, `query/query.ts`, `query/guard.ts`,
`assemble/assemble.ts`, `assemble/gather.ts`, `composition/quality/adapters.ts`,
`interfaces/cli/...`) importuoja TIK kanoninę; infra kopijos nuorodos yra
lygiai dvi (Grep 2026-09-01): `src/tests/infrastructure-persistence.test.ts:30`
ir barrel re-export'as `src/infrastructure/index.ts:50` — būtent testas laiko
eksportus „gyvus" ir praleidžia juos pro `dead-export-gate.test.ts`. Pati kopija
`createManifest` jau deleguoja į kanoninę (87-95 eil., 2026-08-23 dedup
palikimas) — tai sąmoningai nebaigto valymo likutis. Sprendimas: IŠTRINTI infra
kopiją su jos nuorodomis. Trynimas yra šio task'o aiški apimtis (cleanup
pagrindimas pagal `.claude/rules/constraints.md`: nulis produkcinių kvietėjų,
silpnesnė validacija nei kanoninės, dubliuota atsakomybė). Alternatyva
„sustiprinti kopijos freshness iki kanoninės" atmesta: dvi to paties kontrakto
realizacijos yra pati problema — viena jų vėl atsiliks, kaip jau atsiliko.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/persistence/code-index-store.ts` (TRINAMAS)
- `src/infrastructure/index.ts` (šalinama tik 50 eil. re-export eilutė)
- `src/tests/infrastructure-persistence.test.ts` (šalinama tik code-index
  dalis: importo blokas 25-30 eil. ir testas „code-index store: JSONL
  byte-compat forma ir manifest roundtrip" 179-206 eil.; kiti testai —
  attempt store, task-graph, state-history — LIEKA)

Draudžiama:
- `src/application/code-intelligence/store/code-index-store.ts` (kanoninė
  realizacija — nekeičiama)
- `src/tests/dead-export-gate.test.ts` (vartas turi likti žalias be pakeitimų)
- `src/infrastructure/fs/code-intelligence-fs-adapter.ts` (turi kitų vartotojų)
- `dist/**`
- `node_modules/**`

## Veiksmas
- PRIEŠ trynimą persitikrinti Grep'u, kad importuotojų sąrašas nepasikeitė:
  `infrastructure/persistence/code-index-store` nuorodos tebėra tik testas ir
  `src/infrastructure/index.ts` barrel'is. Jei atsirado naujas importuotojas —
  stop (žr. ## Stop).
- Ištrinti `src/infrastructure/persistence/code-index-store.ts`.
- `src/infrastructure/index.ts`: pašalinti
  `export * from "./persistence/code-index-store.js";` eilutę.
- `src/tests/infrastructure-persistence.test.ts`: pašalinti code-index importo
  bloką ir code-index testą; patikrinti, kad failo antraštės komentaras (1-3
  eil.) nebemini code-index store.
- Testų lūkestis: `pnpm test` žalias be susilpninimų — likę
  `infrastructure-persistence.test.ts` testai bėga, `dead-export-gate.test.ts`
  ir architektūros vartai praeina; kanoninės saugyklos byte-compat dengimą
  toliau laiko `characterization-code-index.test.ts` ir
  `code-intelligence-store-integrity.test.ts` (importuoja kanoninę).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei prieš trynimą Grep rastų
NAUJĄ `infrastructure/persistence/code-index-store` importuotoją (scope
pasikeitė) arba jei pašalinus barrel eilutę lūžtų svetimas modulis, kuris
vartojo šiuos vardus per `infrastructure/index.js` (tai reikštų nematytą
produkcinį kvietėją — trynimo prielaida klaidinga).

## Neįtraukta
- Kanoninės saugyklos (`application/code-intelligence/store/code-index-store.ts`)
  elgesio keitimai — jos freshness teisingas, čia tik šalinamas dublikatas.
- `src/infrastructure/index.ts` kitų re-export eilučių auditas — jei vykdytojas
  pastebės daugiau mirusių barrel eilučių, fiksuoti ataskaitoje kaip kandidatą
  atskiram task'ui.
- JSONL byte-compat formos testo perkėlimas prie kanoninės saugyklos — dengimas
  ten jau egzistuoja (`characterization-code-index.test.ts`); dubliuoti nereikia.
