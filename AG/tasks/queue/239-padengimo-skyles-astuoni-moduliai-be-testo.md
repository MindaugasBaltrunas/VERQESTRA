# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/**` turi testus, importuojančius `context-pack/arrest-attribution.js`,
`release-readiness/architecture-boundary-check.js`, `context-pack/compression-cache-sources.js`,
`scheduling/wave-decision-hash.js`, `learning/session-file-events.js`, `composition/quality/adapters.js`,
`composition/runtime/bootstrap-adapters.js`, o `ui-app/src/tests/model/` turi tikro `api.ts` kliento testą
be `vi.mock` (grep 2026-09-05: nė vieno) — ALREADY_IMPLEMENTED: cituok importus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, T5; `scratchpad/audit-tests.md` §5):
148 iš ~670 produkcinių failų be tiesioginio testo importo, 519/1828 eksportuotų funkcijų (28 %) vardu
nefigūruoja jokiame teste. Dvigubas signalas („!", nei importo, nei vardo): `arrest-attribution.ts`
(`attributeFailure`, `attributeCanaryOutcome`, `isArrestCountableAttribution`,
`selectArrestCountableHumanReviewTaskIds` — kanarėlių arešto ATRIBUCIJA), `architecture-boundary-check.ts`
(`checkArchitectureBoundary`) + `boundary/baseline.ts` (`newArchitectureBoundaryViolations` —
`KNOWN_ARCHITECTURE_BOUNDARY_VIOLATION_BASELINE` be varto), `compression-cache-sources.ts`
(`contextCompressionCacheSources` — pack'o KEŠO RAKTŲ šaltinis), `wave-decision-hash.ts`
(`computeWaveDecisionHash`; `scheduling-decision-hash.test.ts` dengia domain grafo hash'ą, ne šį),
`session-file-events.ts` (`parseSessionFileEvent`, `resolveSessionFileKinds`), `quality/adapters.ts`
(`qualityGatesPorts`, `preflightPorts`, `preflightPolicies`, `auditDirectorPorts`, `resolveModelForTier`),
`runtime/bootstrap-adapters.ts` (`rollbackStablePorts`, `bootstrapProjectPorts`, `rollbackCleanUntracked`).
ui-app: `model/api.ts` — `apiEnvelopes.test.ts` dengia tik vokus; token'o antraštė, `REQUEST_TIMEOUT_MS`
nutraukimas, `readErrorMessage`, `parseDashboardData` kelias per tikrą `fetch` stub'ą — netestuoti
(WavesPanel incidento klasė, 2026-08-26). Tik nauji testai — produkcija nekinta.

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/context-pack-arrest-attribution.test.ts` (numatomas naujas)
- `src/tests/release-readiness-architecture-boundary.test.ts` (numatomas naujas; dengia ir `boundary/baseline.ts`)
- `src/tests/context-pack-compression-cache-sources.test.ts` (numatomas naujas)
- `src/tests/scheduling-wave-decision-hash.test.ts` (numatomas naujas)
- `src/tests/learning-session-file-events.test.ts` (numatomas naujas)
- `src/tests/composition-quality-adapters.test.ts` (numatomas naujas)
- `src/tests/composition-runtime-bootstrap-adapters.test.ts` (numatomas naujas)
- `ui-app/src/tests/model/api.test.ts` (numatomas naujas; `apiEnvelopes.test.ts` lieka)

Draudžiama:
- `src/application/**`, `src/composition/**` (rasta klaida → `t.todo` su priežastimi ir ataskaita, ne pataisa)
- `ui-app/src/model/api.ts` (task 230 jį keičia — `resumeLoop` čia NETESTUOJAMAS)
- `src/tests/scheduling-decision-hash.test.ts`, `src/tests/dead-export-gate.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `arrest-attribution`: kiekviena eksportuota funkcija — bent po „taip/ne" porą (atributuojama
  kanarėlei vs ne; countable vs ne; human-review id atranka su mišriu sąrašu).
- `architecture-boundary`: `checkArchitectureBoundary` su fake portais — švaru, naujas pažeidimas virš
  baseline'o (raudona), pažeidimas BASELINE'e (praeina), baseline'o įrašas be pažeidimo (pasenęs —
  užfiksuoti faktinį elgesį); `newArchitectureBoundaryViolations` aibių aritmetika.
- `compression-cache-sources`: šaltinių rinkinys deterministinis; keičiant vėliavą/failą keičiasi
  raktas; trūkstamas failas → aiški baigtis, ne išimtis; `wave-decision-hash`: stabilus nuo tvarkos,
  jautrus verdiktams; `session-file-events`: parse tolerantiškas blogai eilutei, `resolveSessionFileKinds`
  pilna rūšių lentelė.
- `composition-quality-adapters`/`composition-runtime-bootstrap-adapters`: portų fabrikai `mkdtemp`
  šaknyje grąžina pilnus objektus; `preflightPolicies` skaito realų `templates`-formos konfigą iš tmp;
  `resolveModelForTier` numatytoji reikšmė; `rollbackCleanUntracked` env `0/1/nėra`; jokio realaus git.
- `ui-app` `api.test.ts` su `vi.stubGlobal("fetch")` (kaip `apiEnvelopes`), be `vi.mock`: `x-vq-ui-token`
  antraštė iš `<meta>`, `AbortError` → „timed out" žinutė, klaidos kūno tekstas patenka į `Error`,
  `fetchDashboard` per `parseDashboardData` atmeta be privalomų laukų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Jei bet kuris naujas testas atskleidžia produkcinę klaidą — pažymėk
`t.todo` su tikslia priežastimi (failas:eilutė) ir įrašyk į ataskaitą; produkcija čia draudžiama.

## Neįtraukta
- `ui/command.ts#probeUiPort` — realų zondą dengia task 225 (`interfaces-http-ui-port.test.ts`).
- Composition hook'ų adapteriai — task 237; `run-coordinator-*`, `integration/*`, `code-intelligence/indexing/*`
  — likusios §5a skylės, atskiros partijos.
- `ui-app` `controller/{useCountUp,useReducedMotion,useQueueUploadController,useThemeController,useAgentActivity}`
  ir `Header`, `Badge`, `EtaBadge` — §5c, atskira UI testų partija.
