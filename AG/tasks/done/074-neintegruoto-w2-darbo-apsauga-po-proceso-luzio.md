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
openspec/changes/verqestra-backlog-v1 — audito P1 (2026-08-29): baigto, bet neintegruoto w2 slot'o būsena gyvena tik `Map` atmintyje ir neišgyvena proceso lūžio.

## Tikslas
Persistinti baigusių, bet dar neintegruotų worker slot'ų projekciją kartu su wave snapshot'u, kad po perkrovimo būtų žinoma, jog šaka laukia integracijos. Šioje dalyje — TIK schema + rašymo kelias; resume elgesys ir orphan reaper eina atskiromis užduotimis.

Žingsnis 0: jei `waveSnapshotSchema` jau turi finished slot'ų lauką ir `persistWaveSnapshot` jį rašo — grąžink ALREADY_IMPLEMENTED su eilučių įrodymu.

## Agentai
Privaloma grandinė: `readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester`. readme-guard pirmas.

## Failai
Leidžiama:
- `src/application/scheduling/wave-snapshot.ts`
- `src/application/scheduling/wave-snapshot-persist.ts`
- `src/application/scheduling/wave-scheduler.ts`
- `src/tests/scheduling-wave-snapshot.test.ts`

Draudžiama:
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-snapshot.ts`: pridėk `finished_slots` masyvą (worker_id, worker_index, task_id, attempt, branch, worktree_path, finished_at) su `.default([])` ir pakelk `WAVE_SNAPSHOT_SCHEMA_VERSION` — `looseObject` + default privalo palikti senus diske gulinčius snapshot'us validžius be migracijos.
- `wave-snapshot-persist.ts`: `WaveSnapshotState` gauna OPCIONALŲ `finishedSlots` lauką (kad `scheduling-wave-graph.test.ts` iškvietimai nesulūžtų), o `persistWaveSnapshot` jį verčia į `finished_slots` projekciją kaip ir `live_slots`.
- `wave-scheduler.ts:89`: perduok `state.finishedSlots` reikšmes į `persistWaveSnapshot` state.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei schemos keitimas negalėtų likti atgal suderinamas su jau įrašytais snapshot'ais be migracijos kelio, arba jei failas viršytų 500 eilučių ribą.

## Neįtraukta
Resume kelio dispatch guard (kita užduotis). Orphan reaper eskalacijos vartas (kita užduotis). Merge logika `worktree-branch-integration.ts`. UI atvaizdavimas (065-b). Preserved ref'ų retencija (075).
