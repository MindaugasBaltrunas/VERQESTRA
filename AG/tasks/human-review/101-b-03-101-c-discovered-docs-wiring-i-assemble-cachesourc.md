# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 101-discovered-docs-prijungti-su-cache-tapatybe-arba-pasalinti
- 101-a-02-101-b-control-doc-roots-turinio-cache-saltiniu-mod

> 2026-09-02 pataisyta: abi priklausomybės buvo proza („(A dalis)", „101-b — …"), o ne
> task id, tad planuoklė jas laikė `missing-dependency` ir task'as nepateko į bangą (w2 stovėjo
> tuščias). Abu task'ai yra `done`.

## Tikslas
Užpildyti sąmoningai paliktą lizdą: `GraphFirstContextCandidates.docsSnippets` (`assemble.ts:238`) visada `[]`, nors atranka (`context-selection-policy.ts:133`) kibirą jau apdoroja. Šis task'as prijungia discovered docs prie surinkimo IR uždaro cache tapatybės sąlygą, be kurios prijungimas draudžiamas.
Žingsnis 0: jei `assemble.ts` jau importuoja `discoverControlDocCandidates` ir `docsSnippets` nebėra tuščias literalas — ALREADY_IMPLEMENTED su Grep citata (įskaitant cache šaltinių eilutes).

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai

> 2026-09-03 praplėsta po parko (`09:26:11`, `changed files outside allowed paths`).
> Scope buvo per siauras pagal paties task'o mandatą: `context-cache-model.ts` eilutė
> LEIDŽIA kelti `CONTEXT_CACHE_VERSION`, o abu pinantys testai tą konstantą tvirtina —
> versijos pakėlimas jų neliesti NEGALI. Tai buvo autorystės, ne vykdymo klaida, tad
> ribos ne silpninamos, o pataisomos iki realios apimties.
>
> 2026-09-03 ANTRAS parkas (`12:27:14`, `budget_enforcement_failed=context files 11 > 8`)
> kilo iš pačios šios anotacijos: ji gulėjo TARP `Leidžiama:` ir `Draudžiama:`, o
> `allowedBlock` (`src/domain/tasks/allowed-paths.ts:50-57`) ima VISKĄ tarp tų dviejų
> žymeklių. Ne-bullet eilutėje `collectPathTokensFromLine` (92-98 eil.) paima VISUS
> backtick tokenus, tad proza `09:26:11`, `changed files outside allowed paths` ir
> `CONTEXT_CACHE_VERSION` tapo trimis „keliais": 8 tikri + 3 iš teksto = lygiai 11.
> Anotacija perkelta VIRŠ `Leidžiama:` — ten parseris jos nemato. Tuo pačiu iš
> `Draudžiama:` pašalintas `context-pack-guards.test.ts`: pirmasis taisymas jį įrašė į
> `Leidžiama:`, bet paliko ir draudime — tas pats kelias abiejose pusėse yra ne riba,
> o dviprasmybė vykdytojui.

Leidžiama:
- `src/application/context-pack/assemble/assemble.ts`
- `src/tests/context-pack-assemble.test.ts`
- `src/application/context-pack/context-cache-model.ts` (TIK `CONTEXT_CACHE_VERSION`)
- `src/application/context-pack/context-pack-schema.ts` (tik jei architektas neša discovered tekstą pack'e)
- `src/application/context-pack/render-execution-context.ts` (tik jei naujas pack laukas renderinamas)
- `src/tests/context-pack-render-execution-context.test.ts` (numatomas vardas)
- `src/tests/context-pack-guards.test.ts` (pina `CONTEXT_CACHE_VERSION`)
- `src/tests/context-pack-code-index-identity.test.ts` (pina `CONTEXT_CACHE_VERSION`)

Draudžiama:
- `src/application/code-intelligence/retrieval/discovered-docs.ts`
- `src/application/context-pack/discovered-docs-cache-sources.ts` (tik importuojamas, nekeičiamas)
- `src/application/policy-governance/context-selection-policy.ts`
- `src/infrastructure/persistence/context-cache-store.ts`
- `src/tests/context-pack-cache-bypass.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `assemble.ts`: `discoverControlDocCandidates` + `rankDiscoveredDocCandidates` + `selectDiscoveredDocs` rezultatai užpildo `candidateSet.docsSnippets` (238 eil.) ir keliauja į pack'ą architekto pasirinkta forma (schema/renderis keičiami tik jei ta forma to reikalauja).
- `assemble.ts`: 101-b modulio šaltiniai pridedami prie `cacheSources` (157-169 eil., po 097 pakeitimų), kad discovered teksto pasikeitimas anuliuotų cache įrašą; `CONTEXT_CACHE_VERSION` pakeliamas ir sprendimas užfiksuojamas ataskaitoje (CLAUDE.md „Pack'o semantika ir kešas").
- Testai `src/tests/context-pack-assemble.test.ts`: `docsSnippets` nebe tuščias, kai šaknyse yra kontrolinių dokumentų; pakeitus dokumento turinį cache raktas skiriasi (ne `hit`); be dokumentų elgesys nepakitęs.

## Patikra
- `pnpm test`

## Stop
- Sustok, jei prijungimas reikalautų silpninti biudžeto ar atrankos testus.
- Sustok, jei prireiktų keisti `ContextCachePort` kontraktą ar `context-selection-policy.ts`.
- Sustok, jei `CONTEXT_CACHE_VERSION` kėlimas nepakanka cache tapatybei — tai signalas, kad šaltiniai surinkti neteisingai.
- Commit'ink tik po žalio `pnpm test`.

## Neįtraukta
- Determinizmo pataisa ir docstring'ai `discovered-docs.ts` (A dalis).
- Cache šaltinių modulio įgyvendinimas (task 101-b).
