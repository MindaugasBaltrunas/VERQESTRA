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
Uzfiksuoti testu, kad `waveWorktreePort.policyEnabled()` skaito politika is `runtimeRoot/config/worktree-policy.json`. Be sio testo kelio regresija vel praeitu tyliai — simptomas matomas tik gyvame diegime.

## Agentai
Privaloma grandine: readme-guard -> tester.

## Failai
Leidziama:
- `src/tests/composition-wave-scheduler-adapters.test.ts`
- `src/tests/scheduling-wave-provisioning.test.ts`

Draudziama:
- `src/composition/**`
- `src/application/**`
- `templates/**`
- `dist/**`

## Veiksmas
- Naujame `composition-wave-scheduler-adapters.test.ts`: tmp runtimeRoot su `config/worktree-policy.json` turiniu `{"enabled":true}` -> `policyEnabled()` grazina `true`.
- Tas pats be failo -> grazina `false` (default), ir failas senoje `AG/config/` vietoje NEijungia politikos.
- Patikrinti, ar `scheduling-wave-provisioning.test.ts` nesiremia senu `agRoot` keliu; jei remiasi — suderinti.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros zalios. Produkcinio kodo netaisyk — jei testas rodo, kad kelias vis dar `agRoot`, sustok ir pranesk.

## Neitraukta
Produkcinio kodo keitimas. Install sablono patikra.
