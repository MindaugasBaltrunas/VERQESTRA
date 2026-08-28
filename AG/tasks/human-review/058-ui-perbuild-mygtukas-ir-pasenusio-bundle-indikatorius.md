# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus nurodymas — build valdymas turi būti mygtuku iš panelės (rankinis skėlimas po auto-split duplicate_scope: čia SERVERIO dalis, UI dalis — 058-b)

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei serveris turi `POST /api/ui/rebuild` endpoint'ą, kuris paleidžia
`pnpm --dir ui-app build`, ir UI view atsakyme yra `bundle_stale` /
`bundle_built_at` laukai — ALREADY_IMPLEMENTED.

## Tikslas
SERVERIO pusė dashboard'o perbuild valdymui (UI mygtukas — atskiras 058-b,
priklausantis nuo šio):

1. **Staleness faktai view'e**: prie UI view pridedami `bundle_built_at`
   (`ui-app/dist/index.html` mtime) ir `bundle_stale` (naujausio
   `ui-app/src` failo mtime > bundle mtime). Skaičiuoja SERVERIS.
2. **Rebuild endpoint'as**: `POST /api/ui/rebuild` paleidžia fiksuotą
   komandą `pnpm --dir ui-app build` tuo pačiu proceso šablonu kaip
   `/api/runtime/loop/start` (`process-lifecycle-ports`). Jokių parametrų
   iš request'o. Vienu metu — vienas build: antras prašymas gauna
   „jau vyksta". Atsakymas: `started | already-running`; būsenos
   užklausai — `running | ok | failed` su išvesties uodega klaidos atveju.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-rebuild.ts` (naujas)
- `src/interfaces/http/ui-router.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/interfaces/http/ui-port-store.ts`
- `src/composition/ui/router-adapters.ts`
- `src/composition/ui/lifecycle-adapters.ts`
- `src/tests/interfaces-http-ui-rebuild.test.ts` (naujas)
- `src/tests/interfaces-http-router.test.ts`

Draudžiama:
- `ui-app/**` (UI dalis — 058-b)
- `src/application/**` (proceso paleidimas — interfaces/composition lygis;
  jei architect nuspręs kitaip — stop ir klausk)
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
UI mygtukas, indikatoriaus rodymas, i18n, CSS — visa tai 058-b (blokuotas
šiuo task'u). Automatinis perbuild'as po loop task'ų. Websocket
auto-reload.
