## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
- `openspec/changes/verqestra-backlog-v1`
- `docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md` (skyrius „R4")

## Tikslas
Paruošti dirvą archyvavimo porto praplėtimui: `coordinatorCompletionPort` archyvavimo kelias turi
naudoti bendrą `openSpecReconcileFs` adapterį vietoje savo inline porto literalo. Elgesys
nesikeičia nė per baitą — tai dubliavimo pašalinimas, kad kitas žingsnis galėtų praplėsti
`OpenSpecArchiveFsPort` neliesdamas composition sluoksnio.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`

Draudžiama:
- `src/application/task-execution/openspec-archive.ts`
- `src/composition/runtime/node-adapters.ts`
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `.env`
- `node_modules/**`

## Veiksmas
- `coordinator-execution-adapters.ts:234-245` kvietime vietoje inline objekto (`exists`,
  `readTextFileIfExists`, `writeTextFileAtomic`, `makeDirectory`, `rename`) perduok importuotą
  `openSpecReconcileFs` iš `../runtime/node-adapters.js`.
- Įsitikink, kad `openSpecReconcileFs` (`node-adapters.ts:47-57`) tiekia TIKSLIAI tuos pačius
  penkis metodus tuo pačiu `rename -> nodeFsAdapter.renamePath` atvaizdavimu; jei kuris nors
  skiriasi — sustok ir pranešk, o ne pritaikinėk.
- Nešalink `nodeFsAdapter` importo, jei jį naudoja kiti šio failo portai.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok nedelsiant, jei prireiktų keisti `openspec-archive.ts`,
`node-adapters.ts` arba preflight archyvinės nuorodos taisyklę — tai jau kito žingsnio riba.

## Neįtraukta
- `deferred-children` logika ir porto praplėtimas (kita užduotis).
- Užstrigusių vaikų atrakinimas, `slugFromTask` keitimas, skaidymo kelias.
