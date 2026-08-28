# Repair Task

## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: AssertionError [ERR_ASSERTION]: naujas eksportas be kvietėjo. Prijunk jį arba įrašyk į KNOWN_UNCALLED su priežastimi (FORWARD / NEPRIJUNGTA / ŠEIMA) — tylus pra

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
- `pnpm typecheck && pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/interfaces/http/ui-rebuild.ts` (naujas)
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/interfaces/http/ui-port-store.ts`
- `src/tests/interfaces-http-ui-rebuild.test.ts` (naujas)

Draudžiama:
- `src/application/**`
- `src/composition/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1
