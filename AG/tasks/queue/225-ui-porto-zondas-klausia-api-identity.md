# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 234-dead-export-gate-mato-export-sarasus-ir-testinius-kvietejus-skaiciuoja-atskirai

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/ui/command.ts` `probeUiPort` siunčia HTTP GET `/api/identity` (ne pliką TCP
`createConnection`) ir `occupied` rezultatą pildo `fingerprint` per `identityFingerprint(body)` —
ALREADY_IMPLEMENTED: cituok `http.request` bloką ir `identityFingerprint` kvietimą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, U2 ✓; `scratchpad/audit-ui.md` F3):
gryna taisyklė laukia fingerprint'o (`ui-port-store.ts:253,304` `probed.fingerprint === fingerprint`
→ `already-running`), bet vienintelis produkcinis zondas `command.ts:36-52` yra plikas TCP connect —
`fingerprint` NIEKADA neužpildomas; `identityFingerprint` (`ui-port-rules.ts:125`) turi 0 produkcinių
kvietėjų, `command.ts:94-98` `already-running` šaka negyva, `ui-port-rules.ts:12-13` antraštė netiesa.
Pasekmės: gyvas MŪSŲ serveris → naujo `verqestra loop` autostart'as po 30 s malonės lango → „occupied be
fingerprint'o" → ANTRAS serveris kitu portu ir nauju token'u, `ui-server.json` perrašomas; su `AG_UI_PORT`
— „taken by another process" kiekvienam startui. Etalonas (`D:\React\AG_loop\AG\orchestrator\src\ui\ui-port.ts:300-335`)
zonduoja `http.request` GET `/api/identity` su terminu ir parsina `identityFingerprint`. Serverio pusė
(`/api/identity` maršrutas, `uiIdentityPayload`) NEKINTA — ji jau teisinga.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/composition/ui/command.ts` (`probeUiPort`, 26-52 eil.)
- `src/tests/interfaces-http-ui-port.test.ts` (realaus zondo testai prie gyvo `node:http` serverio `listen(0)`)
- `src/tests/dead-export-gate.test.ts` (task 234 galėjo įrašyti `…ui-port-rules.ts#identityFingerprint`/`#buildUiIdentityBody` į `KNOWN_UNCALLED` — prijungus eilutės išbraukiamos)

Draudžiama:
- `src/interfaces/http/ui-port-rules.ts` (taisyklės ir `identityFingerprint` nekinta — jos jau teisingos)
- `src/interfaces/http/ui-port-store.ts` (`resolveUiPort` nekinta)
- `src/interfaces/http/ui-router.ts` (`/api/identity` maršrutas nekinta)
- `src/interfaces/http/ui-lifecycle.ts` (autostart'as tik gauna teisingą zondą)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `probeUiPort`: `http.request({ host: "127.0.0.1", port, path: UI_IDENTITY_ROUTE, method: "GET" })`
  su terminu (etalono 1,5 s; `PORT_PROBE_TIMEOUT_MS` perkalibruojamas su komentaru — 300 ms HTTP atsakymui
  per lėtą mašiną nepakanka); kūnas → `identityFingerprint(body)`.
- FAIL-CLOSED lieka: `ECONNREFUSED` → `free`; atsakymas su mūsų forma → `occupied` + `fingerprint`;
  bet koks kitas atsakymas, ne-JSON, 403, timeout, socket klaida → `occupied` BE fingerprint'o.
  Kūno dydis ribojamas (pvz. 4 KiB) — svetimas procesas negali priversti skaityti be galo.
- Antraštė `command.ts` 29-35 eil. ir `Host` — zondas siunčia `127.0.0.1:<port>`, kad praeitų
  `isLoopbackHost` (`ui-router.ts:59`); nuoroda į etaloną komentare.
- Testai `interfaces-http-ui-port.test.ts`: gyvas `createServer` `listen(0)` — (a) atsako
  `buildUiIdentityBody(fp)` → `{ state: "occupied", fingerprint: fp }`; (b) atsako svetimą JSON/HTML →
  `occupied` be fingerprint'o; (c) neklausantis portas → `free`; (d) serveris, kuris neatsako iki termino
  → `occupied` be fingerprint'o ir zondas baigiasi per terminą.
- `dead-export-gate.test.ts`: išbraukti `identityFingerprint`/`buildUiIdentityBody` `KNOWN_UNCALLED`
  eilutes, jei jos yra.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `UiPortProbeResult` formą reikėtų plėsti — ji yra
`ui-port-rules.ts` kontraktas (draudžiamas), zondas turi tilpti į esamą `{ state, fingerprint? }`.

## Neįtraukta
- `ui.pid` įrašas ir `removeStaleRuntimeRecord` klaida (`ui-lifecycle.ts:140-151`) — task 232.
- Kompozicijos `probeUiPort` atskiras testų failas (`composition-ui-command.test.ts`) — realų zondą dengia
  šio task'o testai `interfaces-http-ui-port.test.ts`; task 239 jo nedubliuoja.
- Etalono 2-ojo serverio įrašo perrašymo apsauga (`writeUiServerRecord` guard) — nebereikalinga, kai
  `already-running` pasiekiamas.
