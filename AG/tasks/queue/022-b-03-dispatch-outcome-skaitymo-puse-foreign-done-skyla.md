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
