# Tasks: AG Loop benchmark v1

> Checklist state last verified 2026-08-07 (queue task `0017`, HEAD `88a23a5`).
> Evidence: [`verification-2026-08-07.md`](verification-2026-08-07.md). A box is `[x]` only
> where a green check on that run demonstrates the acceptance criterion. Boxes whose
> acceptance needs a **live benchmark run** stay `[ ]`: the CLI composition root refuses
> `run`, `baseline create`, `compare`, `report` and `verify` with
> `BenchmarkCapabilityUnavailableError`, so the sample ledger is empty, the stored report
> covers 0 samples, and **no benchmark number exists or may be quoted**.

- [x] **BENCH-001 / queue 0002** — patvirtinti public kontraktus, sluoksnių ribas ir workspace integraciją.
  - Acceptance: package/API kontraktai kompiliuojami ir architektūros testas draudžia importus aukštyn.
  - Evidence 2026-08-07: `pnpm --dir AG/benchmark test` builds via `tsc -p tsconfig.json` before running, and `src/tests/architecture-boundaries.test.ts` is green.
- [x] **BENCH-002 / queue 0003** — sukurti scenario, result ir configuration schemas bei validatorių.
  - Dependencies: BENCH-001.
  - Acceptance: invalidūs, nepilni ir traversal inputai atmetami testais.
  - Evidence 2026-08-07: schema/validator tests green, including the self-referential value, unknown-field, future-schema and non-semantic-version refusals.
- [x] **BENCH-003 / queue 0004** — sukurti versijuotą bent 20 fixture/scenario rinkinį.
  - Dependencies: BENCH-002.
  - Acceptance: visos reikalaujamos kategorijos padengtos ir suite hash deterministinis.
  - Evidence 2026-08-07: 24 scenario files in `AG/benchmark/scenarios` across code/bugfix/refactor/ui/tests/docs/arch/security/impossible; `every missing category is named, not just the first` and the read-order / key-order / line-ending / Unicode-normal-form hash-stability tests are green.
- [x] **BENCH-004 / queue 0005** — įgyvendinti schema-validų JSONL sample store ir environment capture.
  - Dependencies: BENCH-003.
  - Acceptance: atomic append, corruption detection, secret redaction ir aplinkos fingerprint testai praeina.
  - Evidence 2026-08-07: sample-store and environment-capture tests green.
- [x] **BENCH-005 / queue 0006** — įgyvendinti izoliuotą fixture/worktree runnerį.
  - Dependencies: BENCH-004.
  - Acceptance: main nejuda, scope patikrintas, cleanup saugus, crash palieka diagnozuojamą būseną.
  - Evidence 2026-08-07: containment tests green — `a path that climbs out of the checkout is refused`, `an absolute path is refused rather than resolved`, `writing into .git is refused`, `a target that exists and is not a file is refused rather than written over`.
  - **Platform gap:** `a symbolic link out of the checkout is refused, whether it is the target or a parent` was SKIPPED on this Windows host (`this host does not permit creating symbolic links`). Symlink containment is covered only by the Linux leg of `ci.yml` and was not observed passing in this run.
- [x] **BENCH-006 / queue 0007** — įgyvendinti AG Loop, direct-agent ir deterministic-control adapterius.
  - Dependencies: BENCH-005.
  - Acceptance: režimai gauna palyginamus inputus; mokamas/network vykdymas tik explicit.
  - Evidence 2026-08-07: adapter tests green; the offline smoke asserts both networked modes are refused without `--allow-network`.
- [x] **BENCH-007 / queue 0008** — įgyvendinti nepriklausomą verified-acceptance verifierį.
  - Dependencies: BENCH-006.
  - Acceptance: empty diff, failed check, out-of-scope, security ir outcome mismatch niekada nepriimami.
  - Evidence 2026-08-07: verifier tests green — `an agent's own done grants nothing over an empty change`, `a declared check that failed rejects the run, whatever the agent reported`, `a change outside the declared scope is rejected and named`, `the same change under a security scenario fails the security gate instead`, and the inconclusive-outranks-failed rule.
- [x] **BENCH-008 / queue 0009** — įgyvendinti agreguotas metrikas ir nulinio vardiklio semantiką.
  - Dependencies: BENCH-007.
  - Acceptance: visos BENCH-7 metrikos padengtos deterministiniais unit testais.
  - Evidence 2026-08-07: metrics tests green.
- [x] **BENCH-009 / queue 0010** — įgyvendinti baseline manifestą, hash ir compatibility vartus.
  - Dependencies: BENCH-008.
  - Acceptance: nesuderinama suite/config/policy/metodologija negali būti palyginta.
  - Evidence 2026-08-07: manifest and canonical-hash tests green; the live report demonstrates the gate refusing to compare without `configHash`/`policyHash`.
- [ ] **BENCH-010 / queue 0011** — įgyvendinti trijų pakartojimų statistiką ir regresijos verdictą.
  - Dependencies: BENCH-009.
  - Acceptance: mean/median/min/max/stddev ir improved/stable/regressed/inconclusive taisyklės ištestuotos.
  - **OPEN 2026-08-07 — the implementation exists, the tests do not.** `summarizeDistribution` (`src/domain/statistics/distribution.ts`), `compareScenario` (`src/domain/comparison/scenario-comparison.ts`) and `compareBenchmark` (`src/domain/comparison/benchmark-comparison.ts`) are imported by **no test in `src/tests/**`** — verified by import grep. `compareBenchmark` additionally has no caller anywhere in the repository and is not exported from the barrel `src/index.ts`. The only `median`/`standardDeviation` references under `src/tests/` are hand-built fixtures in `benchmark-report.test.ts` / `report-fixtures.ts`, which exercise the *renderer*, not the statistics or the verdict rules. `MINIMUM_NONDETERMINISTIC_OBSERVATIONS` is asserted in `benchmark-cli-composition.test.ts`, but that is the ≥3 *plan* rule, not the statistics. The acceptance criterion is literally "…taisyklės ištestuotos", so this box cannot be checked. The whole BENCH-010 domain is orphaned along with the run pipeline.
- [ ] **BENCH-011 / queue 0012** — prijungti benchmark validate/run/baseline/compare/report/verify CLI.
  - Dependencies: BENCH-010.
  - Acceptance: exit kodai, dry-run, scenario filter ir klaidų kontraktai turi CLI testus.
  - **OPEN 2026-08-07.** The parser, exit codes and error contracts are tested against fakes (`src/tests/benchmark-cli.test.ts`, green), but only `validate` is actually connected. `src/interfaces/cli/benchmark-cli-composition.ts` refuses `run`, `createBaseline`, `compare`, `report`, `verify`, `loadBaseline` and `loadCurrentSummary` with `BenchmarkCapabilityUnavailableError(RUN_PIPELINE_PROVIDER)`. Five of the six subcommands this item names are not wired, so it cannot be closed. **This is the item that unblocks the rest of the change.**
- [x] **BENCH-012 / queue 0013** — generuoti deterministines JSON ir Markdown ataskaitas.
  - Dependencies: BENCH-011.
  - Acceptance: ataskaita turi verdictą, įrodymus, režimų palyginimą, scenarijus ir ribotumus.
  - Evidence 2026-08-07: `src/tests/benchmark-report.test.ts` green — `the report states the verdict, both runs, the modes, the scenarios and the limitations`, `the Markdown report carries every declared section, in order`, `a mode section carries both sides and the differences BENCH-3 requires to be reported`, `both formats are byte-identical across renderings of the same inputs`, `no report carries a generation timestamp`, `a credential in a reproduction argument is redacted, and no path is disclosed`. Unlike BENCH-011, the generator is reachable in production by its own entry point (`package.json` → `benchmark:report` → `dist/interfaces/report/benchmark-report-entrypoint.js`), independent of the refused CLI `report` capability, and it did produce both files in this run.
  - Caveat: against the real (empty) ledger only the `inconclusive`/`no-baseline` path executes — the mode-comparison and scenario sections are proven from fixtures. That is legitimate evidence for "the report *has* these sections", which is what the criterion states, but it is not evidence that any measured comparison has ever been rendered.
- [x] **BENCH-013 / queue 0014** — pateikti read-only benchmark HTTP/SSE kontraktą UI.
  - Dependencies: BENCH-012.
  - Acceptance: loopback/token apsauga ir autoritetingo reporto contract testai praeina.
  - Evidence 2026-08-07: covered by `pnpm --dir . test`, green at 2369/2369.
- [ ] **BENCH-014 / queue 0015** — sukurti Benchmark UI puslapį.
  - Dependencies: BENCH-013.
  - Acceptance: loading/empty/error/inconclusive/regressed būsenos ir scenarijų drill-down ištestuoti.
  - **OPEN 2026-08-07 — flaky test, not a missing one.** The page and all six states exist. `src/view/pages/BenchmarkPage.test.tsx > "shows regression reasons and lets a scenario be selected for drill-down"` failed 3 of 4 runs with `Found multiple elements with the text: a new security violation appeared`: the scenario reason renders both in the *Regression reasons* panel and in the auto-selected scenario's drill-down, so the test's singular `getByText` races the selection effect. The fix is in `./ui-app/src/**`, which queue task `0017` is forbidden to edit — it needs its own task. A drill-down assertion that only passes sometimes does not demonstrate the drill-down.
- [x] **BENCH-015 / queue 0016** — integruoti deterministinį benchmarką į CI ir release vartus.
  - Dependencies: BENCH-014.
  - Acceptance: PR nenaudoja mokamų modelių; manual/scheduled full workflow ir stale/regressed release blokavimas ištestuoti.
  - Evidence 2026-08-07: `benchmark-ci-workflow-contract.test.ts` green inside the orchestrator suite; the offline smoke requires both networked modes to be refused without `--allow-network`; and the `benchmark_evidence` gate was **observed blocking live** in this run's `ag final-audit --json` (0 samples, no baseline). Release blocking is demonstrated, not just unit-tested.
- [ ] **BENCH-016 / queue 0017** — atlikti trijų pakartojimų validaciją, dokumentaciją ir closure auditą.
  - Dependencies: BENCH-015.
  - Acceptance: backend/UI testai 3 kartus žali, reportas šviežias, OpenSpec checklist uždarytas tik pagal įrodymus; nepagrįstas „geriausias rinkoje“ teiginys draudžiamas.
  - **OPEN 2026-08-07 — verdict `blocked`.** The verification ran; the closure did not earn it. Three independent blockers: (1) the report measures 0 samples with no baseline, so it cannot be "šviežias" in any sense that matters — BENCH-011 is the cause; (2) `ui-app` is not green three times running — BENCH-014; (3) 37 unrelated task files are still pending, so `ag final-audit` reports `not_complete`. Documentation was updated and the checklist was closed strictly against evidence, so those two sub-goals are met. No effectiveness claim of any kind is made, and none is possible without a number. Full record: [`verification-2026-08-07.md`](verification-2026-08-07.md).

## Added 2026-08-07 by the closure audit

- [ ] **BENCH-017** — pririšti benchmark reporto provenance prie vartų.
  - Dependencies: BENCH-011.
  - Rationale: the `benchmark_evidence` gate recomputes nothing *and verifies nothing*. To flip it green a file needs only `schemaVersion: 1`, an `agCommit` matching HEAD, `sampleCount > 0`, a `verdictBasis` other than `no-baseline`, and verdict `improved`/`stable` (`benchmark-evidence-check.ts` conditions; `suite-report-view.ts` classification). The identity hashes are `z.string()` with no `.min(1)` and are never compared to anything; `scenarios/suite.lock.json` is never read by the gate; `sampleCount` is never cross-checked against the ledger; the report carries no digest of itself. Because `reports/` is gitignored, a hand-written report is untracked and invisible in any diff — yet `describeBenchmarkEvidence` writes `ok (stable)` into the committed `AG/project/final-release-proof.md`. The only control today is the "never hand-edit" note in the two READMEs, which is a norm, not a control. By contrast `suite.lock.json` *is* defended: it is tracked and a hand edit fails `scenario-suite.test.ts` in CI. The report is the one artefact with neither tracking nor a hash.
  - Acceptance: the generated report carries the sample-ledger digest and the suite lock hash; the gate refuses a report whose `suiteHash` does not match `scenarios/suite.lock.json` or whose `sampleCount` does not match the ledger it names. `computeBaselineManifestHash` is the existing primitive to extend.
  - Same family, found 2026-08-07: `REPRODUCTION_BASE_ARGUMENTS` (`src/application/report/benchmark-report-model.ts:259`) hardcodes `["ag","benchmark","report"]`, so every generated report tells its reader to reproduce it with a command that is currently refused (exit 5). The command that actually writes the file is `pnpm --dir AG/benchmark benchmark:report` — the value `BENCHMARK_REPORT_COMMAND` already holds on the orchestrator side. Fixing it also touches the pinned expectation at `src/tests/benchmark-report.test.ts:417`. Not fixed in 0017: changing report output mid-audit would have altered the very artefact being audited.
- [ ] **BENCH-018** — pririšti `PAID_MODEL_ARGUMENTS` prie CLI opcijų lentelės.
  - Rationale: the paid-flag list `["--allow-network","--live"]` is hand-copied in two places — `offline-smoke.ts` and `benchmark-ci-workflow-contract.test.ts` — and neither is derived from or pinned against `BENCHMARK_CLI_OPTIONS`. A third paid opt-in flag added later would be policed by neither the smoke guard nor the workflow contract. The exit-code duplication is already pinned this way, so the pattern exists. Same class: the contract test's `MODEL_CREDENTIAL_NAMES` recognizes only Anthropic/Claude/OpenAI names, so a `GEMINI_API_KEY` in a workflow would not trip it.
  - Acceptance: a test derives the paid-flag list from `BENCHMARK_CLI_OPTIONS` and fails when a paid option exists that the smoke guard does not know about.
