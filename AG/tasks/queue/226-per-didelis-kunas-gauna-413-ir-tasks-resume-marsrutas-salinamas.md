# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 223-api-dashboard-nesa-ui-rebuild-busena

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/http/ui-error-mapping.ts` eksportuoja `RequestBodyTooLargeError` klasę,
`src/composition/ui/server.ts` `readRequestBody` ją meta, o `createUiServer` catch'as jai atsako 413
JSON PRIEŠ `request.destroy()`, ir `ui-router-mutations.ts` nebeturi `/tasks/resume` šakos —
ALREADY_IMPLEMENTED: cituok klasę, catch'ą ir `handlePost` be `resume`.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, U3; `scratchpad/audit-ui.md` F1, F4):
`server.ts:66-78` viršijus 8 MiB daro `request.destroy()` ir meta plain `Error`; `ui-router-mutations.ts:82`
laukia `error.name === "RequestBodyTooLargeError"` iš `readJsonBody`, bet `command.ts:141` `readJsonBody`
tik parsina JAU perskaitytą kūną — vardas egzistuoja tik teste (`interfaces-http-router.test.ts:252`
`Object.assign(new Error(), { name })`). Realus scenarijus: `POST /tasks/queue/upload` > 8 MiB → socket'as
sunaikintas → `createUiServer` catch bando 500 į sunaikintą socket'ą → naršyklė mato „Failed to fetch",
ne 413; `ui-router-model.ts:18` komentaras („virsta 413, ne 500") — netiesa. Antras radinys tame pačiame
faile: `POST /tasks/resume` (`ui-router-mutations.ts:112-114`) nuo task 049 neturi kliento (Header eina
per `/api/runtime/loop/start`; mobile-gateway grep — 0), gyvas tik testams (`router-contracts.test.ts:115`,
`router.test.ts:215`). Kliento `api.resumeLoop` išėmimas — task 230.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/composition/ui/server.ts` (`readRequestBody` 60-79 eil.; catch'as 199-208 eil.)
- `src/interfaces/http/ui-error-mapping.ts` (`RequestBodyTooLargeError` klasė; `mapJsonBodyError` gauna klaidą, ne `boolean`)
- `src/interfaces/http/ui-router-model.ts` (18 eil. komentaras — tiesa apie 413 vietą)
- `src/interfaces/http/ui-router-mutations.ts` (82 eil. `withJsonBody`; 110-114 eil. `/tasks/resume` šalinama)
- `src/tests/composition-ui-server.test.ts` (123-141 eil. „nutraukia ryšį" → tikrina 413 ir `routed === 0`)
- `src/tests/interfaces-http-router.test.ts` (250-258 eil. per tikrą klasę; 215 eil. `resume` → 404)
- `src/tests/interfaces-http-ui-security.test.ts` (99-118 eil. `mapJsonBodyError` parašas)
- `src/tests/interfaces-http-router-contracts.test.ts` (115-120 eil. `/tasks/resume` kontraktas šalinamas)

Draudžiama:
- `src/composition/ui/command.ts` (`readJsonBody` lieka `JSON.parse` — riba gyvena kiaute)
- `src/interfaces/http/task-upload.ts` (`UploadTooLargeError` 5 MB riba — kitas sluoksnis, nekinta)
- `ui-app/**` (task 230)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ui-error-mapping.ts`: `export class RequestBodyTooLargeError extends Error` (name fiksuotas);
  `mapJsonBodyError(error: unknown)` → `instanceof` → 413 `{ error: "request body is too large" }`, kitaip
  400 „invalid JSON body" — VIENA klasė abiem kelams, ne `name` string'as.
- `server.ts` `readRequestBody`: viršijus ribą mesti `RequestBodyTooLargeError` (destroy ATIDĖTAS);
  `createUiServer` catch: `instanceof` → `writeHead(413)` + JSON per `mapJsonBodyError`, `end()`, ir TIK
  TADA `request.destroy()` — mandagus atsakymas prieš nutraukiant likusį srautą; kiti — 500 kaip dabar.
- `ui-router-mutations.ts`: `withJsonBody` catch naudoja `mapJsonBodyError(error)`; `/tasks/resume` šaka
  ir jos komentaras (110-114 eil.) šalinami — nežinomas POST kelias krenta į esamą 404/`empty`.
- `ui-router-model.ts:18` komentaras: riba ir 413 gyvena transporto kiaute (`server.ts`), maršrutas jos nemato.
- Testai: kiautas — > 8 MiB `POST` gauna 413 JSON (arba `fetch` atmeta ryšį, jei klientas dar siunčia —
  abi baigtys priimtinos, bet `routed === 0` privaloma); `mapJsonBodyError` su klase/be jos; router —
  `resume` → nebe 200, kontraktų testas pašalintas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `mobile-gateway` (`pnpm test:mobile` čia nepaleidžiamas)
turėtų `/tasks/resume` kvietėją — grep 2026-09-05 rodo 0, bet paketas į `pnpm test` neįeina.

## Neįtraukta
- Kliento `api.resumeLoop`, `apiEnvelopes.test.ts` ir fixture'ai su `/tasks/resume` — task 230.
- `ensureLoopRunning` portas lieka — jį naudoja `/tasks/queue/upload`.
- Įkėlimo 5 MB/50 failų ribos (`task-upload.ts`) — nekinta, jau teisingai 413.
