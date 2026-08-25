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
docs/audits/022-stop-bridge-foreign-nonce-diagnosis-2026-08-25.md

## Tikslas
Įgyvendinti rašymo pusės apsaugą: Stop hook'o bridge įrašas, kurio nonce nebėra aktyvus, nebegali apsimesti gyvu `done` — jis žymimas kaip pasenęs, išlaikant `stopStateSchema` atgalinį suderinamumą.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/state/stop-bridge.ts`
- `src/tests/**`

Draudžiama:
- `src/infrastructure/adapters/claude-dispatch-outcome.ts`
- `src/application/scheduling/slot-task-runner.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Diagnozės dokumente užfiksuota kryptis yra autoritetas; jei jis krypties 2 (rašymo pusės `stale`) neapima, sustok ir pranešk.
- `stop-bridge.ts` rašymo kelyje palygink įrašomą nonce su aktyviu bandymo nonce ir pasenusį įrašą pažymėk atskiru statusu vietoj `done`; nauji laukai — tik opcionalūs, kad seni įrašai liktų skaitomi.
- Padenk testu abu kelius: aktyvus nonce -> `done`, pasenęs nonce -> pasenusio įrašo žyma.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų keisti esamų `stopStateSchema` laukų prasmę senų įrašų skaitytojams.

## Neįtraukta
- `claude-dispatch-outcome.ts` skaitymo pusės elgesys (sekantis task'as).
- Application lygio regresinis 021-d-05 testas (sekantis task'as).
- `slot-task-runner.ts` nonce valymo kontraktas.
