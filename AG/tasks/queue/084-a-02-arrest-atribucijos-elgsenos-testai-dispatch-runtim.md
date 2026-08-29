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
