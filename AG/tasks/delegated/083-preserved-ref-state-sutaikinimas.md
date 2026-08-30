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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Preserved darbo metaduomenys turi islikti kartu su ref'u. Siandien `recordPreservedTaskScope` raso i `context.runtimeRoot` (worktree kopijos `vq/state/`), o ref'as gyvena bendrame `.git` — kopijai dingus lieka beveidis ref'as (GeoGravity 2026-08-29: 15 ref'u, 14 be irasso). Irasas turi eiti i PIRMINIO medzio runtime sakni.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidziama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/tests/interfaces-cli-rollback-stable.test.ts`

Draudziama:
- `src/infrastructure/git/preserved-ref-retention.ts`
- `src/interfaces/cli/admin/status.ts`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `recordPreservedTaskScope` sakni issprendzia per esama `ports.runGit` (`rev-parse --path-format=absolute --git-common-dir` -> pirminio medzio saknis -> `<primary>/vq`), o ne per `context.runtimeRoot`; nepavykus — fail-closed grizimas i `context.runtimeRoot` su aiskia log eilute.
- Irase pridedami atributacijai butini laukai: `run_id` (jei prieinamas kontekste) ir `created_at` salia esamu `task_id`/`ref`/`commit`/`base_ref`/`paths`; formatas lieka atgal suderinamas su `preserved-ref-retention.ts` skaitytoju.
- `ROLLBACK PRESERVED:` eilute rodo faktini `record=` kelia, kad operatorius matytu, kur irasas nugulė.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros zalios. Sustok, jei patvariai sakniai issprensti prireiktu naujo porto arba composition wiring — tai atskiras sprendimas.

## Neitraukta
Ref'u atributacija/sutaikinimo praejimas ir `unattributed` zymejimas (kitas darbas). Status komandos matomumas (treciasis darbas). Ref'u trynimo politika (075 scope). Automatinis preserved darbo atkurimas (063 scope). Dashboard vaizdas (065).
