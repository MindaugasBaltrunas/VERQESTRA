## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/infrastructure/bootstrap/architecture-graph-store.ts` `readGraph` ir
`readProgress` (dabar 47-61 eil.) parse'ina per zod schemą (ne
`JSON.parse as`) — ALREADY_IMPLEMENTED: cituok schemas ir jų naudojimą kaip
įrodymą.

## Tikslas
Audito P3 (2026-09-01): nevaliduoti runtime būsenos skaitymai. Patikrinta
`src/infrastructure/bootstrap/architecture-graph-store.ts` (DĖMESIO — failas
gyvena `bootstrap/`, ne `persistence/`): `readGraph` (47-51) ir
`readProgress` (57-61) daro `JSON.parse(raw) as ArchitectureGraph` /
`as ArchitectureProgress` be jokios validacijos — sugadintas ar svetimos
formos `vq/state/architecture/{graph,progress}.json` keliauja gilyn kaip
„teisingas" ir lūžta toli nuo priežasties (arba, blogiau, nelūžta —
`initProgress` idempotencija remiasi laukų forma). Precedentas tame pačiame
repo: code-index skaitymo pusė po 2026-08-23 audito 3 validuojama schema
prie modulio. Rašymo pusė jau saugi kitaip: `withStateFileLock` mutex'as
(19-35 eil. istorija) saugo nuo lygiagrečių rašymų, bet ne nuo šiukšlių
diske. Sprendimas: zod schemos `ArchitectureGraph` ir `ArchitectureProgress`
formoms (prie modulio arba domain'e šalia tipų — vykdytojo sprendimas pagal
sluoksnių taisykles: domain be node: importų, zod ten leidžiamas kaip
`policy-proposals-log.ts` pavyzdyje), skaitymas per `parseWithSchema` tipo
kelią su aiškia klaida, įvardijančia failą.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/bootstrap/architecture-graph-store.ts`
- `src/domain/architecture/architecture-graph-schema.ts` (numatomas naujas —
  jei schema dedama domain'e prie tipų; jei vykdytojas ją deda store
  modulyje — be naujo failo, įrašyti į ataskaitą)
- `src/tests/infrastructure-bootstrap.test.ts` (store skaitymo testai)

Draudžiama:
- `src/domain/architecture/index.ts` tipų PRASMĖS keitimas (schema atspindi
  esamus tipus, ne juos keičia; barrel eksportas naujam failui leidžiamas)
- `src/infrastructure/fs/state-file-lock.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Schema: `ArchitectureGraph` ir `ArchitectureProgress` zod atitikmenys,
  išvesti iš esamų tipų (z.infer sutapimo patikra per tipą, kad schema ir
  tipas negalėtų išsiskirti tyliai).
- `readGraph`/`readProgress`: `JSON.parse` rezultatas per schemą; klaida —
  aiški, su failo keliu (basename be vidinių absoliučių kelių) ir zod
  pranešimu. Elgesio klausimas „mesti ar grąžinti null" — spręsti pagal
  kvietėjų kontraktus (Grep: readGraph/initProgress vartotojai
  bootstrap/architektūros kelyje) ir pagrįsti ataskaitoje: sugadintas
  failas NEGALI tyliai virsti „grafo nėra", jei kvietėjas tada jį perrašytų.
- Testų lūkestis: (1) regresija — šiukšlinis JSON (validus JSON, ne ta
  forma) → aiški klaida, ne tylus objektas; (2) sugadintas JSON → aiški
  klaida; (3) teisingas roundtrip žalias; (4) `initProgress` idempotencijos
  testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei kvietėjų analizė
parodytų, kad kuris nors kelias SĄMONINGAI remiasi tuo, kad sugadintas
failas praeina (tokio elgesio įteisinti negalima, bet jo lūžimas būtų
kontrakto keitimas).

## Neįtraukta
- Kitų `vq/state` skaitytojų `JSON.parse as` auditas — jei vykdytojas
  pastebės analogų, fiksuoti ataskaitoje kaip kandidatus; masinis perrašymas
  ne čia.
- `graph.json`/`progress.json` formos evoliucija — schema fiksuoja esamą
  formą.
