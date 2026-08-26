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
openspec/changes/verqestra-backlog-v1
`src/application/task-execution/verify-task.ts:181`

## Tikslas
Prijungti rašymo-aktyvumo signalą prie baigties priežasties: kai vykdytojas nepadarė nė vieno rašymo įrankio kvietimo, `TASK NOT DONE` eilutė privalo tai pasakyti, o ne siųsti operatorių ieškoti dingusio darbo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/tests/helpers/fake-task-run-ports.ts`
- `src/tests/**`

Draudžiama:
- `src/domain/**`
- `src/infrastructure/**`
- `src/composition/**`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `fake-task-run-ports.ts` `rules` literalas implementuoja `readExecutorWriteActivity` ir `resolveNoCommitReviewReason` tomis pačiomis grynomis funkcijomis kaip composition adapteris; po to `run-coordinator-ports.ts` abu narius padaro PRIVALOMUS (nuimamas laikinas `?`).
- `verify-task.ts`: iš jau perskaityto `claudeLog` gaunamas `writeActivity`, perduodamas į `resolveNoCommitDisposition`, o human-review priežastis imama iš `ports.rules.resolveNoCommitReviewReason` vietoj inline literalo eilutėje 183. Ne-git šaka (`isRepo === false`) ir `rollback` šaka lieka nepakitusios.
- Testai: rašymų buvo + nėra commit'o → sena `possibly rolled back` priežastis; rašymų NEBUVO → priežastyje `executor made no write-tool calls`; abiem atvejais verdiktas `human-review`, `preserved_work` priesaga elgiasi kaip anksčiau.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok nedelsiant, jei sprendimas imtų reikšti, kad task'as be rašymų uždaromas kaip `done` arba kad dispozicija gauna naują šaką — keičiasi TIK priežasties eilutė.

## Neįtraukta
- Skaidymo taisymas (task 033).
- `ALREADY_IMPLEMENTED` markerio semantikos keitimas.
- Automatinis tokių task'ų uždarymas.
