# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/code-intelligence/code-map/coverage.ts`
`computeCodeMapCoverage` priima `ImportEdge[]` įėjimą, `CodeMapCoverage` tipas
turi briaunų laukus (pvz. `edges_total`, `edges_rendered_in_mmd`), o
`src/tests/code-intelligence-code-map.test.ts` turi patikrą, kad diagrama be
`-->` briaunų su netuščiu `ImportEdge[]` duoda `coverage_percent < 100` —
ALREADY_IMPLEMENTED: cituok signatūrą, tipo laukus ir testo assert'ą kaip
įrodymą.

## Tikslas
Code-map aprėptis visiškai nematuoja priklausomybių briaunų (patikrinta
2026-09-01, `src/application/code-intelligence/code-map/coverage.ts`):
`computeCodeMapCoverage` (62-102 eil.) tikrina TIK simbolių member eilutes
klasių blokuose ir failų blokų buvimą; `-->` briaunų netikrina niekur — Grep
`-->` visame code-map kataloge randa tik `generator.ts`. Operatoriaus
reprodukcija (2026-09-01): pašalinus VISAS `-->` briaunas iš diagramos,
aprėptis lieka 100 % ir `architecture code-map --check` grąžina sėkmę.
Briaunų tiesos šaltinis — `generator.ts` `renderImportEdges` (121-136 eil.):
iš `ImportEdge[]` (indekso išspręstas `toTarget`), filtras į `knownFiles`,
dedupe per `fromId-->toId` raktą. Tai ta pati 2026-08-23 pamokos klasė, kuri
užrašyta pačiame `coverage.ts` (54-57 eil.): aprėptis, kurios vardiklis
priklauso nuo to paties, ką ji matuoja, negali parodyti trūkumo — briaunos
šiandien į vardiklį apskritai nepatenka. Sprendimo kryptis: aprėptis gauna tą
patį `ImportEdge[]` įėjimą ir laukiamų briaunų aibę išveda TA PAČIA logika
kaip generatorius — per bendrą helper funkciją, ne kopiją (kopija vėl
išsiskirtų tyliai).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/code-intelligence/code-map/coverage.ts`
- `src/application/code-intelligence/code-map/generator.ts` (laukiamų briaunų
  aibės išvedimas iškeliamas į bendrą eksportuotą helper'į, kurį naudoja ir
  `renderImportEdges`, ir aprėptis)
- `src/interfaces/cli/architecture/command.ts` (365 eil. kvietėjas — perduoda
  `imports`; 372-383 eil. išvestis — nauji laukai)
- `src/tests/code-intelligence-code-map.test.ts`
- `src/tests/interfaces-cli-architecture.test.ts` (351 eil. assert'ina
  `coverage_percent: 100` — gali reikėti atnaujinti pagal naują išvestį)

Draudžiama:
- `src/application/code-intelligence/code-map/index-projection.ts`
  (`ImportEdge` šaltinis teisingas — nekeičiamas)
- `src/application/code-intelligence/indexing/**` (indekso statyba neliečiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/application/code-intelligence/code-map/generator.ts`: iš
  `renderImportEdges` (121-136 eil.) iškelti laukiamų briaunų raktų aibės
  (`fromId-->toId` po `knownFiles` filtro ir dedupe) skaičiavimą į bendrą
  eksportuotą funkciją; `renderImportEdges` ją naudoja renderiui.
- `src/application/code-intelligence/code-map/coverage.ts`:
  `computeCodeMapCoverage` priima `ImportEdge[]` (ir iš jų + failų sąrašo
  išveda `knownFiles` ta pačia helper logika), suparsina `A --> B` eilutes iš
  Mermaid teksto, trūkstamas briaunas deda į `missing_symbols` ir įtraukia
  briaunas į vardiklį taip, kad briaunos pašalinimas iš diagramos MAŽINTŲ
  `coverage_percent`. `CodeMapCoverage` tipas plečiasi (pvz. `edges_total`,
  `edges_rendered_in_mmd`).
- `src/interfaces/cli/architecture/command.ts` (365 eil.): perduoti `imports`
  (jau pasiekiami 351 eil. destruktūravime) į `computeCodeMapCoverage`;
  žmogui skirtoje išvestyje parodyti naujus briaunų laukus.
- Testų lūkestis (`code-intelligence-code-map.test.ts`): (1) regresija —
  diagrama be `-->` briaunų su netuščiu `ImportEdge[]` → aprėptis < 100 % ir
  trūkstamos briaunos matomos `missing_symbols`; (2) pilna diagrama su visomis
  briaunomis → 100 %; (3) helper'io ir renderio sutarimas — generatoriaus
  sugeneruota diagrama visada duoda visų briaunų aprėptį.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
`code-map.coverage.json` formą skaito dar koks vartotojas už
`command.ts`/testų ribų (schemų kontrakto keitimas) — Grep `CodeMapCoverage`
2026-09-01 rodė tik coverage.ts, command.ts ir du testus.

## Neįtraukta
- `renderImportEdges` renderinamo Mermaid formato keitimai — briaunų eilučių
  forma lieka ta pati, keičiasi tik matavimas.
- `code-map --check` slenksčio/exit-code politika — sėkmės kriterijus lieka
  koks buvęs; jei operatorius norės kirsti bėgimą žemiau 100 %, tai atskiras
  task'as.
- `ui-app` aprėpties atvaizdavimas — `code-map.coverage.json` UI šiandien
  neskaito (Grep 2026-09-01), naujų laukų rodymas dashboard'e — ne čia.
