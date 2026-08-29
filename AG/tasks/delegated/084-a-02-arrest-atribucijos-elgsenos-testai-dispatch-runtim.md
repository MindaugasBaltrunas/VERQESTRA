## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Uždengti testais ką tik prijungtą arrest atribuciją
`src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`:
infrastruktūrinė human-review baigtis nebeturi didinti arešto skaitiklio, o kompresijai
atribuotina — turi. Be šių testų regresija grįžtų tyliai.

## Agentai
PRIVALOMA grandinė (be praleidimų): readme-guard -> tester

## Failai
Leidžiama:
- `src/tests/interfaces-cli-dispatch-runtime.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
- `src/application/context-pack/arrest-attribution.ts`
- `src/application/context-pack/compression-arrest-observer.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pridėti atvejį: canary kohortos task'as, parkuotas human-review su infrastruktūrine
  `phase` (pvz. lease/worktree/preflight) — arešto skaitiklis NEDIDĖJA, marker'is nerašomas.
- Pridėti atvejį: canary task'as su kompresijai atribuotina baigtimi (`compilation`
  `phase`, `compression_applied` su feature, `compression_effect=compiled`) — arešto
  skaitiklis didėja ir `CANARY ARREST RECORDED` eilutė logeoujama.
- Pridėti atvejį: nesantis arba neperskaitomas context-size įrašas — `prepareWorkerPromptTask`
  nemeta, dispatch'as tęsiasi, arestas neužskaitomas.

## Patikra
- `pnpm build`
- `pnpm test:file dist/tests/interfaces-cli-dispatch-runtime.test.js`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei testui praeiti reikėtų keisti
produkcinį kodą — tai reikštų, kad ankstesnis prijungimas neužbaigtas, ir tai atskiras darbas.
Testo nesilpnink, kad pažaliuotų.

## Neįtraukta
Produkcinio kelio keitimai, analitikos pusė, arešto lango logika, silent-canary skaitiklio
lango semantika (task 085).
