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
Worktree politika skaitoma is `AG/config/worktree-policy.json`, o `verqestra install` ja deda i `vq/config/`. Operatorius ijungia `enabled:true`, o loop'as amzinai mato default `enabled:false` ir antras worker slot'as nepakyla (GeoGravity, 2026-08-27). Perkelti skaityma i `runtimeRoot/config` — ten gyvena visos kitos politikos.

## Agentai
Privaloma grandine: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidziama:
- `src/composition/loop/wave-scheduler-adapters.ts`
- `src/composition/loop/command.ts`

Draudziama:
- `src/application/scheduling/worktree-policy.ts`
- `src/tests/**`
- `templates/**`
- `dist/**`

## Veiksmas
- Architect patvirtina varianta (A): `waveWorktreePort` deps keiciasi is `{ projectRoot, agRoot }` i `{ projectRoot, runtimeRoot }`, kelias tampa `path.join(deps.runtimeRoot, "config", "worktree-policy.json")`.
- Coder pakeicia `wave-scheduler-adapters.ts:107-115` ir kviesima `command.ts:113` (runtimeRoot jau yra scope, zr. `command.ts:96`).
- Reviewer patikrina, kad `agRoot` niekur kitur nebeliko pakibes ir sluoksniu ribos nepazeistos.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros zalios. Sustok, jei paaiskeja, kad reikia keisti `application/scheduling/worktree-policy.ts` kontrakta arba kita politiku keliu.

## Neitraukta
Regresijos testai (atskira uzduotis). Install sablono patikra (atskira uzduotis). Worktree kurimo logika.
