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
Skaitymo pusėje atskirti dvi `foreign-done` klases: svetimo TASK'O bridge (ignoruoti kaip dabar) ir SAVO task'o pasenusio bandymo bridge (neignoruoti tyliai — įskaityti kaip vėlavusį darbo įrodymą arba garsiai deklaruoti verify priežastyje).

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-dispatch-outcome.ts`
- `src/tests/**`

Draudžiama:
- `src/infrastructure/state/stop-bridge.ts`
- `src/application/scheduling/slot-task-runner.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Diagnozės dokumente užfiksuota kryptis yra autoritetas; jei jis skaitymo pusės skilimo neapima, sustok ir pranešk.
- `claude-dispatch-outcome.ts:131-140` `foreign-done` kelyje palygink bridge task tapatybę su laukiamu task'u ir grąžink atskirą rezultatą savo task'o pasenusiam bandymui; svetimo task'o elgesys nesikeičia.
- Padenk testu abi klases, įskaitant tai, kad savo pasenusio bandymo atvejis patenka į verify priežastį, o ne dingsta tyliai.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei elgesio pakeitimas reikalautų susilpninti esamą FOREIGN testą.

## Neįtraukta
- `stop-bridge.ts` rašymo pusė (ankstesnis task'as).
- Application lygio regresinis 021-d-05 testas (sekantis task'as).
- LLM kvietimai, queue loop vykdymas.
