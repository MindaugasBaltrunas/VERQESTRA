# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`POST /api/ui/rebuild` paleidžia fiksuotą komandą `pnpm --dir ui-app build` per portą, be jokių parametrų iš request'o; vienu metu leidžiamas vienas build'as.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

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

## Veiksmas
- Jei maršrutas `/api/ui/rebuild` jau egzistuoja `ui-router-mutations.ts` — ALREADY_IMPLEMENTED, sustok.
- `ui-rebuild.ts`: komanda fiksuota kode; proceso paleidimas per esamą `ProcessLifecyclePorts` šabloną (kaip `/api/runtime/loop/start`); būsena laikoma `ui-port-store.ts`.
- Atsakymas: `started` arba `already-running`; būsenos užklausa grąžina `running | ok | failed`, o `failed` — su išvesties uodega.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei proceso paleidimui prireiktų `src/application/**`.

## Neįtraukta
Composition wiring realiam spawn'ui (sekanti dalis), bundle staleness laukai (jau padaryti), UI mygtukas ir CSS (058-b), automatinis perbuild'as po loop task'ų, websocket auto-reload.
