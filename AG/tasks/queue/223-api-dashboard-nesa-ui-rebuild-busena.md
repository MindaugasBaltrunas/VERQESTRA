# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 234-dead-export-gate-mato-export-sarasus-ir-testinius-kvietejus-skaiciuoja-atskirai

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/http/ui-router.ts` `/api/dashboard` šaka prie `bundleStalenessFields(facts)` prisega ir
`ui_rebuild` lauką iš `ports.uiRebuild.status()`, o `src/composition/ui/router-adapters.ts` `uiRebuild`
objektas turi `status: () => uiRebuildStatus(…)` — ALREADY_IMPLEMENTED: cituok abi vietas ir
`interfaces-http-router.test.ts` asercijas su `ui_rebuild`.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, U1; `scratchpad/audit-ui.md` F2):
`uiRebuildStatus` (`src/interfaces/http/ui-rebuild.ts:138-151`) neturi nei maršruto, nei produkcinio
kvietėjo — tik testus (`interfaces-http-ui-rebuild.test.ts`, `composition-ui-rebuild-wiring.test.ts`).
Nepavykęs `pnpm --dir ui-app build` įrašo `ui-rebuild.json` su `status: "failed"` ir `output_tail`, bet
naršyklė to niekada nemato: `RuntimePanel` sėkmę sprendžia tik iš `bundle_stale === false`, o klaida
neturi jokio kanalo. Serverio pusė: būsena prisegama prie `/api/dashboard` (tas pats sprendimas kaip
`bundle_stale`, `ui-router.ts:120-128` — klientas ten jau kreipiasi kas 30 s; atskiras maršrutas
reikštų antrą pollingą tam pačiam ekranui). PID į naršyklę NEIŠEINA (nutekėjimo klasė, 2026-08-24).
Kliento pusė (prop'o wiring, `failed` + uodega ekrane) — task 224.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-router.ts` (`/api/dashboard` šaka, 120-128 eil.)
- `src/interfaces/http/ui-router-model.ts` (`UiRouterPorts.uiRebuild` gauna neprivalomą `status()`, 131 eil.)
- `src/composition/ui/router-adapters.ts` (`uiRebuild` objektas, 283-287 eil. — `status` per `uiRebuildStatus`)
- `src/tests/interfaces-http-router.test.ts` (pina `/api/dashboard` kūną `deepEqual`, 148-190 eil.)
- `src/tests/composition-ui-rebuild-wiring.test.ts`
- `src/tests/dead-export-gate.test.ts` (task 234 galėjo įrašyti `…ui-rebuild.ts#uiRebuildStatus` į `KNOWN_UNCALLED` — prijungus eilutė išbraukiama)

Draudžiama:
- `src/interfaces/http/ui-rebuild.ts` (`uiRebuildStatus` semantika nekinta)
- `src/interfaces/http/ui-router-mutations.ts` (POST `/api/ui/rebuild` kelias nekinta)
- `ui-app/**` (task 224)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ui-router-model.ts`: `uiRebuild?: { start(): Promise<unknown>; status?(): Promise<UiRebuildStatusResult> }`
  — `status` neprivalomas ta pačia prasme kaip `bundle` (senas adapteris be jo → laukas praleidžiamas).
- `ui-router.ts` `/api/dashboard`: `ui_rebuild: { status: "ok" | "running" | "failed", tail?: string }`
  — `running` BE `pid`; `failed` su `tail` (jau apkarpyta `UI_REBUILD_OUTPUT_TAIL_MAX_CHARS`); porto klaida
  → laukas praleidžiamas, ne 500 (ta pati degradacija kaip `bundle`).
- `router-adapters.ts`: `uiRebuild.status = () => uiRebuildStatus({ ports: uiRebuildProcessPorts(input), runtimeRoot })`
  — tie patys portai kaip `start`, ne antra kopija.
- Testai: router — `ok`/`running`/`failed` formos, `pid` neišeina, portas be `status` → lauko nėra,
  mestas `status()` → laukas praleistas ir 200; wiring — realus `ui-rebuild.json` `failed` įrašas per
  `uiRouterPorts` duoda `ui_rebuild.status === "failed"` su uodega.
- `dead-export-gate.test.ts`: jei yra `uiRebuildStatus` `KNOWN_UNCALLED` eilutė — išbraukti (vartas
  „disappeared" kitaip raudonas).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `UiRebuildStatusResult` formą reikėtų keisti
(`ui-rebuild.ts` draudžiamas) — tada vokas statomas maršrute iš esamos formos, ne keičiant šaltinį.

## Neįtraukta
- `DashboardPage` → `RuntimePanel` `bundleStale`/`uiRebuild` prop'ų wiring ir `failed` uodegos rodymas — task 224.
- Atskiras `GET /api/ui/rebuild` maršrutas — atmesta (dvigubas pollingas), žr. Tikslas.
- `ui.pid` įrašo klaida (`ui-lifecycle.ts:140-151`) — task 232.
