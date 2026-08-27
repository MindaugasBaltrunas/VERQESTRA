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
openspec/changes/verqestra-backlog-v1/
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R5")

## Tikslas
`decision.json` laukas `task_id` turi būti sistemos ANTSPAUDUOTAS, o ne perimtas iš modelio išvesties. Dabar modelis įrašo nukirstą 50 simbolių slug'ą, o nuosavybės vartas lygina griežta lygybe — todėl kiekvienas task'as, kurio id ilgesnis nei 50 simbolių, amžinai parkuojamas, nors JSON tvarkingas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-slug.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `writeDecision` (`src/interfaces/cli/dispatch/claude-preflight/index.ts`, ~98-103 eil.) yra vienintelis piltuvas kiekvienam sprendimui: ten `task_id` perrašyk autoritetingu task id tuo pačiu spread'u, kuriuo jau dedamas `token_budget_tier`. Modelio reikšmė perrašoma, ne tikrinama.
- Nekeisk nuosavybės palyginimo ir slug'o 50 simbolių ribos — abi teisingos; taisoma ID kilmė, ne palyginimas.
- Testai: (a) preflight su >50 simbolių task id → įrašytame `decision.json` `task_id` sutampa su tikruoju; (b) modelio grąžintas nukirstas `task_id` perrašomas, o ne praleidžiamas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Privaloma laikytis nurodytos agentų grandinės. Sustok, jei sprendimas imtų reikšti nuosavybės varto silpninimą (`startsWith`, prefiksų lyginimą, ilgio normalizaciją) — svetimas sprendimas privalo likti `invalid`.

## Neįtraukta
- Priežasties atskyrimas `dispatch-task.ts` ir `run-coordinator.ts` keliuose — atskira sekanti užduotis.
- `slugFromTask` 50 simbolių riba ir auto-generuojamų change katalogų kelių forma.
- Retry vartų `readDecision` kelias ir 032 grąžinimas į eilę (operatoriaus veiksmas).
