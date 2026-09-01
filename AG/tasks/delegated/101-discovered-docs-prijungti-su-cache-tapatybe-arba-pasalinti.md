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

## Priklausomybės
- 097-context-cache-raktas-ismato-with-code-graph-rezima

## Tikslas
`src/application/code-intelligence/retrieval/discovered-docs.ts` yra neprijungtas produkcinis kodas (vienintelis importuotojas — `src/tests/context-pack-discovered-docs.test.ts`), o jo 200 failų riba NEDETERMINISTINĖ: `collectMarkdownFiles` (133-140 eil.) kerta `MAX_DISCOVERED_DOC_FILES` traversal'o tvarka, o `[...new Set(files)].sort().slice(0, MAX)` (123 eil.) rūšiuoja tik PO to — tam pačiam 201 failo rinkiniui skirtinga `listDirectory` tvarka parenka skirtingus failus, nors docstring 74-75 eil. žada priešingai.
Šis task'as uždaro DVI dalis: architekto verdiktą „prijungti ar šalinti" ir determinizmo pataisą. Wiring, cache šaltiniai ir pack forma — atskiruose task'uose.
Žingsnis 0: jei Glob rodo, kad `discovered-docs.ts` nebeegzistuoja — ALREADY_IMPLEMENTED su Glob citata.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/code-intelligence/retrieval/discovered-docs.ts`
- `src/tests/context-pack-discovered-docs.test.ts`

Draudžiama:
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/code-intelligence/retrieval/markdown-chunks.ts`
- `src/application/code-intelligence/retrieval/ranking.ts`
- `src/application/code-intelligence/retrieval/spec-fragments.ts`
- `src/application/policy-governance/context-selection-policy.ts`
- `src/infrastructure/persistence/context-cache-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- architect: verdiktas „prijungti" ar „šalinti" su pagrindimu ataskaitoje — už prijungimą kalba sąmoningai suprojektuotas lizdas (`assemble.ts:238` `docsSnippets` visada `[]`, `context-selection-policy.ts:133` kibirą jau apdoroja), prieš — papildomas FS skaitymas kiekvienam surinkimui ir cache rakto išplėtimas penkių šaknų turiniu.
- coder: `listControlDocFiles` surenka VISUS kandidatų kelius (gylio apsauga `MAX_DISCOVERY_DEPTH` lieka), tada dedup+sort, ir tik tada `slice(0, MAX_DISCOVERED_DOC_FILES)`; failų SKAITYMO IO lubos nepažeidžiamos, nes skaitymas vyksta vėliau `discoverControlDocCandidates`.
- coder+tester: docstring 74-75 eil. ir antraštės 31-43 eil. „kodėl neprijungta" blokas perrašomi pagal realybę (verdiktas + likę žingsniai), o `src/tests/context-pack-discovered-docs.test.ts` gauna regresiją: 201 markdown failas dviem skirtingom `listDirectory` tvarkom duoda IDENTIŠKĄ kandidatų seką.

## Patikra
- `pnpm test`

## Stop
- Jei architekto verdiktas „šalinti" — NIEKO netrink: sandbox'e trynimo komandos neallowlist'intos. Pateik Grep įrodymus (importuotojai, `application/code-intelligence/index.ts` eksportai), įrašyk verdiktą į ataskaitą ir sustok — trynimas yra operatoriaus veiksmas.
- Sustok, jei prireiktų keisti `assemble.ts`, cache raktą ar pack schemą — tai kitų task'ų scope.
- Sustok, jei determinizmo pataisa reikalautų silpninti esamą testą.
- Commit'ink tik po žalio `pnpm test`, vienu commit'u, tik leistinuose failuose.

## Neįtraukta
- `candidateSet.docsSnippets` wiring `assemble.ts` faile (task 101-c).
- `CONTROL_DOC_ROOTS` cache šaltiniai ir naujas `discovered-docs-cache-sources.ts` (task 101-b).
- `CONTEXT_CACHE_VERSION` kėlimas, `context-pack-schema.ts`, `render-execution-context.ts` (task 101-c).
