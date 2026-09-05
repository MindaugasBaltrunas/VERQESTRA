# Pilnas projekto auditas — 2026-09-05

**Klausimas:** logikos klaidos, konteksto (komentaras ≠ kodas, portas ≠ adapteris) klaidos,
ar funkcionalumas veikia taip, kaip sumanyta, miręs kodas, vartų spragos.

**Metodika.** Dešimt lygiagrečių read-only auditorių, kiekvienas skaitė VISUS savo srities
produkcinius failus (ne ištraukas) ir kryžmino su dengiančiais testais: `shared`+`domain`
(114 failų), loop branduolys `application/{scheduling,task-execution,task-planning,integration}`
(106), likęs `application` (165), `infrastructure` (88), `interfaces/cli`+`composition/cli` (95),
hooks ir guard'ai, `interfaces/http`+`ui-model`+`composition/ui`+`ui-app` (114), likęs
`composition` (24), dokumentacija ↔ kodas, testų kokybė (265+66 failai). Kiekvieną P0/P1
radinį, pažymėtą **✓**, atskirai patikrinau pats (kodas, žurnalas arba runtime būsena).
Nepažymėti — auditoriaus radinys su file:line, mano neperskaitytas. **PLAUSIBLE** — auditorius
pats nurodė, kad reikia papildomo įrodymo.

Būsena prieš auditą: `pnpm typecheck` švarus, `pnpm test` žalias (2344 + 686 testų).
Tai, kas žemiau, yra tai, ko žali testai nemato.

## Suvestinė

| Klasė | P0 | P1 | P2 |
|---|---|---|---|
| Loop / worktree / scheduling | — | 9 | 12 |
| Domain taisyklės | — | 7 | 29 |
| Application (vartai, politika, pack'as) | — | 4 | 15 |
| Infrastructure | — | 3 | 12 |
| CLI | 1 | 7 | 14 |
| Hooks / guard'ai | — | 1 | 8 |
| HTTP / UI | — | 3 | 7 |
| Dokumentacija ↔ kodas | — | 19 | 23 |
| Testai / vartai | — | 5 | 20 |

Bendra tema, kuri kartojasi visose srityse: **mechanizmas parašytas, testuotas per fake'us ir
NEPRIJUNGTAS** (stop-bridge laukimas, preserved-ref reconcile, `bundle_stale`, porto
fingerprint, 413 kelias, `hook-post-bash-sync`, `quarantineStaleDist`). Testai žali, nes fake
portas paduoda tai, ko produkcija niekada nepaduoda.

---

## P0

### P0-1 ✓ `rollback-stable --ref <sha>` / `--task-scope` ignoruojami → pilnas `reset --hard` į stable-ref
`src/interfaces/cli/bootstrap/rollback-stable.ts:412-414` skaito tik `--allow-task-changes`,
`--task-id`, `--run-id`; nežinomi argumentai neatmetami. Registras (`commands-ops.ts:165`) ir
`README.md:193` skelbia `[--task-scope] [--ref <sha>]`. Operatorius su nepush'intais commit'ais
paleidžia `rollback-stable --ref HEAD~1` ir gauna `git reset --hard <stable-ref>` — ne į tą
commit'ą, kurį prašė. Automatinis kelias (`verify-task.ts:231`, `repair-task.ts:90`) kviečia
teisingai, tad loop'as sveikas — pažeidžiamas tik žmogus.

---

## P1 — loop, worktree, scheduling

**L1 ✓ Koordinatoriaus stop-bridge laukimas produkcijoje niekada nesuveikia.**
`composition/loop/coordinator-execution-adapters.ts:353` skaito `AG_DISPATCH_NONCE` iš
KOORDINATORIAUS proceso env; nonce nustatomas tik `claude-dispatch` vaike
(`claude-dispatch-process.ts:126-127`) ir jam pasibaigus trinamas. `waitForOwnStopBridgeDone`
nekviečiamas, `quality-gates` bėga iškart po dispatch'o — 018 incidentas („nėra commit'o", nes
Stop hook'as dar nespėjo) liko atviras. Įrodymas: `orchestrator.log` turi 1360 `DISPATCH`
eilučių ir **0** `COORDINATOR STOP WAIT RESULT`. Testas `composition-cli.test.ts:309` nonce
įrašo į env ranka.

**L2 ✓ `verqestra loop` nevykdo loop prielaidų; exit 78 niekur neemituojamas.**
`runLoopCommand` (`command.ts:490-500`) → `recoverFromCrash` → `runLoopCycle`; portas
`preconditions` naudojamas tik `productTreeDirtyEntries` (`command.ts:397`).
`evaluateLoopPreconditions` (stable-ref, index.lock, git repo, stale dist) kviečiama tik
`loop-guard` (`commands-ops.ts:357`). UI „Paleisti" spawn'ina `["loop"]`. `DIST_STALE_EXIT_CODE`
turi tik apibrėžimą (`exit-codes.ts:13`), `quarantineStaleDist` neprijungta. README:104 žada,
kad stale dist nutraukia loop'ą — netiesa: po `src` redagavimo be build'o ciklas suka seną dist,
o kopijos gauna tą patį dist su šviežiu `.buildstamp`.

**L3 ✓ Runtime-oversize skėlimas parkuoja savo vaikus į human-review.**
`run-coordinator-terminal.ts:399-439`: `enqueueChildTasks` įrašo dalis 2..N su
`blocked_by: <parent>` (`task-splitting.ts:200`), tėvas → `done`, tada
`cascadeBlockedDependents(parent)` → `routeBlockedTasksToHumanReview`
(`task-graph-import.ts:153-183`) perkelia VISUS queue task'us su `blocked_by: parent` į
human-review su „upstream task entered human-review or failed routing". Tėvas yra `done`,
priklausomybė patenkinta — kaskada čia prieštarauja `done` šakai. Latentinis: žurnale
`TASK SPLIT (runtime-oversize)` = 0 (69 kiti skėlimai eina preflight keliu be kaskados).
Fake portas (`fake-task-run-ports.ts:226`) `cascadeBlockedDependents` daro no-op.

**L4 ✓ (struktūriškai) Atkurtas finished slot'as dispatch'inamas antrą kartą.**
`wave-scheduler.ts:412-413` `selectNextWaveTask` filtruoja `started ∪ finishedSlots`, bet
`planPool(current)` → `toWorkerCandidates(current.ready)` (`wave-provisioning.ts:311-331`) be
filtro → `planWorkerPool` ima `ordered[0]`, o `planWaveDispatch` dispatch'ina `pool.slots`, ne
`selection.task` (`wave-dispatch.ts:29-39`). Po crash'o su nesulieta w2 šaka task'as bėga
antrą kartą, o `finishedSlots.set` perrašo pirmąjį įrašą — šaka našlaitė.

**L5 Atkurtas finished slot'as niekada neintegruojamas, jei nebaigia joks kitas task'as.**
`recoverFromCrash` (`wave-scheduler.ts:327-402`) integracijos nekviečia; vienintelis
`integrateFinishedSlots` kvietėjas — `wave-outcome.ts:202-228`. Likus vienam task'ui →
`exhausted/already-started` → exit 1 kiekvieną restartą, kol operatorius neištrina wave
snapshot'o.

**L6 Worktree vaiko runtime būsena išmetama su kopija.**
`wave-integration-adapters.ts:50` surenka tik `context-size.jsonl` ir `token-usage.jsonl`.
Vaiko `runtimeRoot` = `<worktree>/vq` (gitignored), `cleanupWorktree` trina. Prarandama:
`task-ledger.json` (`done` įrašas), `retry-counts.json`, `last-error-signatures.json`,
`cheap-finish/*`, `task-events.jsonl`. Pasekmės: `ledgerDuplicate` w2+ task'ams niekada `true`;
`release-notes`, `task-ledger-sync`, UI ir learning jų nemato; kadangi kopija turi
`-a<attempt>`, kiekvienas bandymas gauna tuščią `retry-counts.json` →
`MAX_RETRIES_PER_ERROR`, `failedAttempts` ir cheap-finish „vieną kartą" galioja per bandymą, ne
per task'ą. Tas pats task'as w1 elgiasi kitaip.

**L7 Koordinatoriaus portai skiriasi pagal įėjimo tašką.**
`command.ts:255-269` (in-process w1) paduoda `preservedWorkReview` ir `cheapFinishOverlay`;
`commands-ops.ts:329-342` (`resumeTask`) — nė vieno; `commands-tasks.ts:110-125`
(`process-queued-task` = kiekvienas worktree vaikas) — be `preservedWorkReview`. Be porto
preserved darbas visada parkuojamas `preserved_work=<ref>`, niekada `recovered`
(`verify-task.ts:253`); tęsiamas task'as cheap finish negauna.

**L8 Po `rebuildDist` bangos viduryje tėvas suka seną kodą, vaikai — naują.**
`wave-integration-adapters.ts:177-185` perstato `dist`; planuoklis ir in-process koordinatorius
lieka seni, `cliEntryPath()` vaikai (preflight/dispatch/diagnose/quality-gates) jau nauji.
`command.ts:12-13` antraštė teigia priešingai; įspėjimo nėra.

**L9 Trys nesuderinti laiko langai.** `LIVE_DISPATCH_MAX_AGE_MS = 90 min`
(`session-baseline.ts:79`) < numatytas large dispatch langas 100 min (180 × 20 s + 40 min,
`turn-budget.ts`); konfigas leidžia iki 4 h > 3 h lease TTL → lease baigiasi vaikui dar dirbant,
o `loop-guard`/antras loop startas jį atlaisvina.

## P1 — domain taisyklės

**D1 ✓ `**/` kelio viduryje reikalauja bent vieno katalogo.**
`allowed-paths.ts:197-203` (pažodinė kopija `scope-lock-rules.ts:130-136`): `**` → `.*`, bet
literalus `/` aplink lieka → `ui-app/src/**/*.tsx` = `^ui-app/src/.*/[^/]*\.tsx$`, o
`ui-app/src/App.tsx` NEATITINKA. Task'ai 026 ir 068 (`AG/tasks/done`) deklaravo būtent šią
formą; toks pakeitimas → „changed files outside allowed paths" → human-review/rollback.
Testai pina tik `src/**` ir `**/x.ts`. Antraštė 171-176 sako „kopija VIENA" — jų dvi.

**D2 Klasifikacijos keyword'ai be žodžio ribų.** `task-classification.ts:57`
`textHaystack.includes(...)`; antraštė teigia priešingai. `migration-coverage.json` paminėjimas
→ `data` → opus; `release-readiness` → `release` → opus; „build"/„guide" → `ui`. Atitinka
2026-09-03 modelių audito radinį (opus 22 % dispatch'ų = 42 % išlaidų).

**D3 Backend BLOCK `/\bexec\s*\([^"']/` pagauna `pattern.exec(line)`.**
`scope-guard-rules.ts:24-25` → Stop hook'as blokuoja bet kurį `apps/api/**` failą su regex
`.exec(`. Etalono 1:1, bet klaidingas.

**D4 Human-review evidence substring'ai be ribų.** `evidence.ts:45,106`: `auth` ⊂
`.claude/agents/task-author.md`, `acl` ⊂ `oracle.ts`, `push` ⊂ `git-push-helper.ts` → parkas.
VERQESTRA pati turi `task-author` agentą.

**D5 Du `Leidžiama:` parseriai.** `allowed-paths.ts:20-23` toleruoja `Leidžiama keisti:`,
`etalonas-rules.ts:184-190` reikalauja tikslaus `leidziama:` → task'as su LLM rašyba scope'ą
gauna, bet `production-file-without-test`, `ui-file-without-*`, `failai-wildcard-*`,
`failai-prose-inside-leidziama` tyliai išjungiami (`leidziamaPaths` → `[]`).

**D6 PLAUSIBLE `lock-steal.ts:80` + `owned-lock.ts:327-328`** — `isForeign(observed=undefined,
stolen=defined)` → `false` → perimtas svetimas lock'as sunaikinamas, nors antraštė žada
priešingai. Testo fake'as naudoja griežtesnę taisyklę nei produkcija.

**D7 PLAUSIBLE `human-review/gates.ts:45-48`** — `HUMAN_REVIEW_APPROVED_RE` be
`markdownFenceMask`: šablono citata fenced bloke = patvirtinimas → visi rizikos vartai nutildomi.
Visi kiti markdown skaitytojai nuo 2026-08-24 fence-aware.

## P1 — application

**A1 ✓ `broad_scope_requires_human_review` apeinamas `src/`.**
`preflight-rules.ts:453` regex `^(\*\*|.+\/\*\*)$` mato tik `**` ir `x/**`;
`matchesAllowedPath` (`allowed-paths.ts:189`) `src/` laiko viso medžio prefiksu, `src/**/*.ts`
— bet kokio gylio glob'u. Trys skirtingi „wildcard" apibrėžimai repo'je.

**A2 ✓ Policy pasiūlymų sprendimai rišami prie `(policy_file, setting_id)`, ne pasiūlymo.**
`policy-proposals-log.ts:160-190`: statusas = paskutinis sprendimas tam nustatymui.
Propose X → reject → propose Y: Y iškart `rejected`; propose A → approve → propose B: B
iškart `approved`, `apply` pritaiko be niekieno sprendimo. `countPendingProposals` nuvertina.

**A3 Pack'o biudžetas su `defaultTaskClassificationPolicy`, be human-review/split balsų.**
`assemble.ts:92-98` komentaras „iki VQ-305" pasenęs; preflight tą pačią užduotį vertina su konfigo
politika → kitas tier → kitas `max_context_chars`. Kešo raktas neša
`task-classification-policy.json`, kurio assemble neskaito. Taisant kelti
`CONTEXT_CACHE_VERSION`.

**A4 PLAUSIBLE Su šablono konfigu retry eskalacija struktūriškai nepasiekiama.**
`max_llm_calls: 3` + `SOFT_BUDGET_RATIO 0.8` → 3-iam dispatch'ui `reduce_context`;
`defer_steps: 1` → eskalacija būtent 3-iam; `freeze_escalation_under_budget_pressure` →
`steps=0`. Patvirtinti: execution records `routing.reason` (`retry-escalation` vs `budget-freeze`).

## P1 — infrastructure

**I1 ✓ `clearStaleIndexLock` linked worktree'e niekada nesuveikia.**
`git-automation.ts:43` `path.join(projectRoot, ".git", "index.lock")` — kopijoje `.git` yra
FAILAS (gitdir rodyklė), tikras lock'as gyvena `<main>/.git/worktrees/<name>/index.lock`.
Stop hook'as w2+ slot'e (`CLAUDE_PROJECT_DIR=worktreeAbs`) nužudyto `git add` lock'o niekada
neišvalo → kiekvienas commit'as krenta → human-review. Taisymas: `git rev-parse --git-dir`.

**I2 ✓ Preserved-ref reconcile produkcijoje nepasiekiamas dviem būdais.**
Vienintelis `refs/verqestra/preserved/*` gamintojas (`rollback-scope.ts:124`) rašo
`"verqestra: preserved task scope"` be `task=<id>`, o `parseTaskIdFromCommitMessage` ieško
būtent `\btask=` → kiekvienas ref'as `task-id-not-found`. Be to `reconcilePreservedRefs`
turi tik testinius kvietėjus. Testas fabrikuoja žinutę su `task=`.

**I3 Du „runtime prefiksų" sąrašai.** `worktree-removal.ts:32-41` (`storage/`, `logs/`,
`node_modules` be `/`) vs `domain/git/changes.ts:22-32`; `worktree-reaper.ts:253` teigia, kad
vienas. `removeTaskWorktree --force` šalina kopiją, kurios vienintelis nešvarumas — produkto
`storage/**` (Laravel), kurį „RESIDUE" doktrina žada palikti žmogui.

## P1 — CLI

**C1 `quality-gates [scope]` pozicinis ignoruojamas** — visada `task`
(`quality-gates.ts:68-76` tik `--scope`). `quality-gates milestone` → `scope: task PASSED`.

**C2 `openspec-reconcile [--apply]`** — flag'o nėra; numatytasis režimas ARCHYVUOJA, dry-run tik
su `--dry-run` (`openspec-reconcile.ts:25`). README ir `docs/spec-workflow.md:52` žada planą.

**C3 `dispatch --adapter <kind>`** — handler'is parsina tik `--adapter=<kind>`
(`dispatch.ts:55`); `--adapter codex` tyliai → dry-run; `--adapter codex task.md` →
`taskFile="codex"`.

**C4 `install [--dry-run]`** — reikalauja `<target-project-dir>` (`install.ts:113-117`);
dokumentuota forma → exit 2.

**C5 `smoke` ir `status` „nieko nekeičia"** — abu kviečia `ensureDirs`, sukuriantį 12 katalogų +
`retry-counts.json`; smoke `dir:` patikros 7/8 tautologinės (tikrina tai, ką ką tik sukūrė).

**C6 `benchmark-loop-cell --allowed-path <p> [--check <cmd>]`** — parseris reikalauja
`--allowed-paths`/`--checks` (`benchmark-loop-cell.ts:44-49`) → exit 2.

**C7** Dar 6 README/registro ↔ handlerio neatitikimai: `optimization-benchmark
[--capture|--compare]` (realiai `--baseline|--compare-baseline|--print-hash`), `learning <list|…>`
(realiai `record|query|summary|approve|reject`), `policy [list|…]` (realiai `show|propose|status`,
usage → exit 1), `report --recent <n>` neparsinamas, `preflight --json` ir `security-verify --json`
JSON nespausdina. `readiness-audit` lygina tik komandų VARDUS, tad nė vieno nemato.

## P1 — hooks

**H1 ✓ Windows trailing tarpas/taškas apeina secret write-policy.** `write-policy.ts:193-201`
`pathBaseName` netrina, tad `.env ` ar `id_rsa.pem ` nesublokuojami (`$` ir `endsWith`
nesutampa), o Win32 CreateFile trailing tarpą/tašką nukerpa → failas nusileidžia kaip `.env`.
Kontrastas: `check-command-allowlist.ts baseExecutable` SĄMONINGAI trina `[.\s]+$`.

## P1 — HTTP / UI

**U1 ✓ `bundle_stale` niekada nepasiekia `RuntimePanel`.** Serveris prisega lauką prie
`/api/dashboard` (`ui-router.ts:120-128`); `RuntimePanel.tsx:100,178` jo laukia, bet
`DashboardPage.tsx` prop'o NEPADUODA (grep: tik `RuntimePanel` ir `types.ts`). „Rebuild
dashboard" po paspaudimo lieka `running` amžinai; nepavykęs build'as niekur nematomas;
„bundle pasenęs" signalas niekada nepasirodo. Testai prop'ą paduoda ranka.

**U2 ✓ Porto zondas niekada neklausia `/api/identity`.** `command.ts:36-52` — plikas TCP
connect, `fingerprint` niekada neužpildomas; `identityFingerprint` (`ui-port-rules.ts:125`) — 0
produkcinių kvietėjų; `already-running` šaka (`command.ts:94-98`) negyva. Gyvas savas serveris →
naujas `verqestra loop` autostart'as po 30 s malonės → „occupied be fingerprint'o" → ANTRAS
serveris kitu portu ir nauju token'u, `ui-server.json` perrašomas; su `AG_UI_PORT` — „taken by
another process" kiekvienam startui. Etalonas zonduoja HTTP GET.

**U3 413 kelias nepasiekiamas.** `server.ts:66-78` > 8 MiB → `request.destroy()` + plain
`Error`; `ui-router-mutations.ts:82` laukia `RequestBodyTooLargeError`, kuris egzistuoja tik
teste. Klientas mato „Failed to fetch".

## P1 — dokumentacija ↔ kodas

**Dk1 ✓ `docs/getting-started.md:83` „Auto-push šiame repo IŠJUNGTAS"** —
`vq/config/git-automation-policy.json`, šablonas ir kodo default'as visi `auto_push_enabled:
true`; Stop hook'as push'ina (`on-stop.ts:440`). Operatorius mano, kad Stop tik commit'ina.

**Dk2 ✓ `AG_ROLLBACK_CLEAN` `commands.env` faile — miręs raktas.** Skaitomas tik iš
`process.env` (`bootstrap-adapters.ts:246`); `commands.env` krautuvai ima tik
`MAX_RETRIES_PER_ERROR` ir `AG_UI_PORT`. Šablono instrukcija „set to 1" nieko nedaro. Tas pats
`CLAUDE_COMMAND=claude` (`models.env:9`) — 0 skaitytojų.

**Dk3 Agentų failai rodo į neegzistuojančius kelius.** `.claude/agents/{readme-guard,
architect,coder,supervisor,tester,audit-director}.md` (ir šablonai) → `AG/project/profile.json`,
kodas skaito `vq/project/profile.json`; `audit-director.md:32`, `documenter.md:17` →
`logs/commit-msg.md`, Stop hook'as skaito `vq/logs/commit-msg.md` → autorinė žinutė praleidžiama,
gaunamas WIP fallback. Tą pačią klaidą kodas injektuoja į task tekstą (`preflight-rules.ts:299`,
`audit-director.ts:138`). 16 agentų failų liepia skaityti `doc/architecture/README.md` (repo:
`docs/architecture.md`).

**Dk4 `task-author` nėra šablonuose** (`templates/.claude/agents/`, `rules/agents.md`) nei
`agents.json` abiejuose medžiuose, nors šaknies `CLAUDE.md` jį daro privalomu.

**Dk5** Mirę šablonai: `templates/vq/config/{mcp-policy,browser-policy,research-policy}.json`,
`templates/vq/schemas/*.schema.json` — 0 skaitytojų. `templates/AG/tasks/` be
`examples/000-etalonas.md`, nors vartai jį cituoja. `templates/CLAUDE.local.md`,
`templates/AG/openspec/project.md` neša `TODO:` į target šaknį.

Likę 12 P1 — CLI lentelė (C1–C7 sutapo su nepriklausomu docs auditoriumi).

## P1 — testai ir vartai

**T1 ✓ `dead-export-gate` nemato `export { x }` sąrašų.** `dead-export-gate.test.ts:199-200`
regex'ai atpažįsta tik `export function|const|class`; produkcijoje 23 `export { … }` per 14 failų.
`:394` testas laikomas kvietėju — antraštė sako, kad vartas gimė iš „testais apkabintas,
composition neprijungė", o 394 eil. būtent tą laiko gyvu. `:392` token'inis sutapimas (bet koks
`render`/`status` kitame faile) prikelia eksportą. Iš to: 12+ funkcijų su tik testiniais
kvietėjais praeina vartą (`reconcilePreservedRefs`, `applyIntegrationPlan`, `appendStateHistory`,
`uiRebuildStatus`, `isDistRebuildCommand`, `isMaintenancePath`, `createIntegrationPlan`,
`runWaveGates`, `measureParallelOverhead`, `decideRetryOrRepair`, …).

**T2 `architecture-gates` mato tik `node:` prefiksą ir tik `import … from`.** `:70,138`.
Apėjimai: `import { readFileSync } from "fs"` domain'e; `await import("../../infrastructure/…")`
interfaces'e (gyvas pavyzdys `coordinator-adapters.ts:289`).

**T3 `gate-covers-ui-app` skaito tik šaknies `package.json`.** `ui-app/package.json`
`"test": "vitest run --passWithNoTests --dir nonexistent"` — žalia.

**T4 Composition hook'ų surišimas be jokio testo.** `hooks/{pre,guard,session}-adapters.ts`,
`hooks/adapters.ts` — 0 importuojančių testų; hooks `fakeFs` (6 failai, ×125) dreifuoja nuo
`nodeFsAdapter` (`exists` be katalogų, `makeDirectory` no-op, niekada nemeta).

**T5 148 iš ~670 produkcinių failų be tiesioginio testo importo**; 519 iš 1828 eksportuotų
funkcijų (28 %) vardu nefigūruoja jokiame teste. Be jokio testo: `arrest-attribution.ts`,
`architecture-boundary-check.ts`, `compression-cache-sources.ts` (kešo raktų šaltinis),
`wave-decision-hash.ts`, `session-file-events.ts`, `quality/adapters.ts`,
`runtime/bootstrap-adapters.ts`, `ui/command.ts`. ui-app: `model/api.ts` visur `vi.mock`'inamas —
tikras klientas netestuojamas (WavesPanel incidento klasė).

---

## P2 — kondensuotai pagal sritį

**Loop.** `worker-lease-store.ts:333` „lock'ai kabo iki 15 min" — realiai 3 h; `scheduling/index.ts`
komentaras apie pašalintą `runGitPlan`; `SCOPE_LOCK_KINDS` dublikatas; `WorkerPoolResolution`
4 laukai neskaitomi; README „timeout aborts the loop" vs pasikartojantis timeout → human-review/split;
`loop-cycle.ts:126-135` resume kilpa be bandymų ribos; `loop-guard` „nieko nekeičia", bet
atlaisvina TTL lease'us; `qualityGatesPorts` default `process.cwd()`; du `ReleaseCheckFsPort`
adapteriai; sprendimo nuosavybė dispatch'e case-insensitive, koordinatoriuje case-sensitive;
benchmark celė aprūpinama iš `packageRoot()/vq/config` — ne paketo `files`.

**Domain.** `dependencies.ts:135-141` `resolveTaskReference` simetriškas → vaikas rezolvuojasi
į tėvą (fail-open); `agent-selection.ts:64` godus `LEADING_LABEL` iki paskutinio dvitaškio;
`bash-command-policy.ts:366` `git log --grep commit` = „mutacija"; `migration-guard.ts` `DELETE`
be `WHERE` per eilutę; `file-classification.ts:40` `apps/x/node_modules/` nepagaunamas;
`Buffer` domain'e (`canary.ts:37`, `changes.ts:59`) — vartas gaudo tik `node:`;
`loop-runtime.ts:49` `JSON.parse("null")` meta už `try`; `graph-hash` per `localeCompare`
(PLAUSIBLE mašinų nesutapimas); `size.ts:118` meta `doc`, repo `docs/`;
`node-verification-rules.ts:72` `findForbiddenDistImports` tik `^import … from`;
`log-digest.ts:135` `010` gauna `0100-…`; `arrest.ts:187` `?? {}` daro `=== null` negyva;
`markdown.ts:90 vs 127` įtraukta antraštė pradeda, bet neužbaigia sekcijos.

**Application.** Loop preflight tikrina sekcijas `includes("# Task")` (substring), manual —
tikslią eilutę; `checkPatikra` atmeta pagrindimą šalia komandos, kurį etalonas leidžia (CLAUDE.md
`pnpm test:mobile` → visada `patikra-unknown-command`); JSON schemų eksportas nesutampa su
loader'iais; `max_context_chars` lyginamas su trimis skirtingais dydžiais; `assemble.ts:319`
`max_llm_calls: 3` hardcoded; `readContextSizeMetrics` meta dėl vienos blogos eilutės →
`compression_quality` vartas blokuojamas; `release-proof.ts:159` SHA patikra fail-open be
`currentGitSha`; wave-sintezuoti task'ai neša tik `architecture-node/…` spec source → manual
preflight `invalid`; `evidence-ledger.ts:24` `JSON.parse` be try; `context-compression.json`
visos vėliavos `false`, canary 0 % — compact-dsl/worker-ir/symbol_slices gyvi tik shadow.

**Infrastructure.** `gitStatus` klaida = `""` = „švarus" (praeina `dirty-worktree`,
`dirty-primary-tree`); `task-state-store.ts:162` `absent → release` trina rekursyviai be
fence'o (langas B perėmė, dar be `owner.json`); win32 EPERM kuriant attempt katalogą →
`already-exists`; `models.env` su BOM praranda pirmą raktą (PLAUSIBLE); `run-process.ts:155`
Windows pnpm eina per `cmd.exe /c`, komentaras „jokio shell'o" netiesa; `preserved-ref-retention`
ir `orphan-worktree-reaper` bucket'ą ieško pagal `<taskId>.md` — po kolizijos (`task-2.md`) vienas
laiko amžinai, kitas eskaluoja; `parseStructuredOutput` parsina nukirptą stdout;
`node-fs-adapter` `list*`/`statPath` ryja EACCES kaip „nėra".

**CLI.** 4 skirtingi flag parseriai scope'e; `codex-dispatch --context-pack` privalomas
nedokumentuotas; `claude-preflight` composition guard'as trūkstamam task'ui grąžina 1, ne 2, o
`io` numetamas → stderr tiesiai; `on-stop-bridge` be argumentų rašo `status="unknown"` exit 0;
`hook-post-bash-sync` registruotas, README'e, bet nekviečiamas niekur; `agRoot` dvi tiesos
(`projectRoot+"AG"` vs `deps.roots.agRoot`); `task-generate --change=<id>` atmetamas su klaida,
siūlančia `--openspec`.

**Hooks.** `cat vq/tasks/../state/task-ledger.json` apeina orchestrator-state regex skaitymui
(`..` nesutraukiamas); `isDistRebuildCommand`/`isMaintenancePath` — N4 mechanizmas nesuvielintas;
package-guard fail-open po ledger append drop; secret-scan be JWT/base64/connection-string;
PreToolUse matcher'iai `Bash|PowerShell`, `Write|Edit` — `mcp__ide__executeCode`, `NotebookEdit`
apeitų (dispatch kelyje MCP nėra → P2); visa apsauga fail-open, jei `$CLAUDE_PROJECT_DIR`
neišplėstas ar dist pasenęs (Claude Code kontraktas).

**UI.** `POST /tasks/resume` be kliento nuo 049; `PolicyProposalsPanel` be `inFlight` → dvigubas
Apply = 409 po sėkmės; i18n aklosios zonos (dinaminiai raktai, `"lt-LT"` hardcoded, 7 tekstai be
rakto); „Rekomenduojama" ženklelis prilipdomas dabartinei reikšmei be `RECOMMENDED_VALUES`;
laukai, siunčiami kas pollingą ir niekur neskaitomi (`slots[].phase|last_event|worktree_path`,
`feature_pairs`, `actions`); `ui.pid` rašomas kaip pid, skaitomas kaip JSON → visada „unreadable";
`.freshness-connecting` be CSS taisyklės → „Kraunama…" gauna žalią „gyva" tašką.

**Docs.** README exit lentelė be 69 (`EXECUTOR_UNAVAILABLE`); getting-started „exit 2" be
politikos (realiai 1); runtime keliai praleidžia `vq/supervisor`, `vq/runtime`;
`vq/logs/session.md` — niekas nerašo; `AG_UI_PORT`, `AG_MAX_WORKERS`,
`AG_PRESERVED_REF_RETENTION_DAYS`, `AG_EXECUTION_CONTEXT_MODE`, `CLAUDE_*_TIMEOUT_MS`,
`AG_STOP_BRIDGE_WAIT_MS` nedokumentuoti; `architecture.md` Stop grandinė praleidžia
frontend/backend/mobile guard'us ir quality-gates; `release.md` „kiekvienas `files` įrašas
tikrinamas" — tik 4 fiksuoti keliai, CI `build:ui` nepaleidžia; `workflow.md:56`
`pnpm test:architecture` neegzistuoja; `benchmark [--mode]` vs realus `benchmark <run|validate|report>`;
`models.env` be `CLAUDE_FABLE_MODEL`; `task-classification-policy.json` etalono keliai
(`src/orchestrator/`, `AG/orchestrator/src/core/`); `issue-import.ts:125` rašo į
`AG/tasks/pending` — bucket'o nėra; `templates/README.md` `pnpm verqestra install` — paketas
`private`, kaip binaras atsiranda PATH'e, nedokumentuota.

**Testai.** `infrastructure-resume-checkpoint.test.ts:118` vienintelė asercija `assert.ok(true)`;
`scheduling-safe-telemetry.test.ts:27` be asercijų; `infrastructure-work-evidence.test.ts:151,190`
tylus `return`; `interfaces-hooks-pre-hooks.test.ts:427` skaito REALŲ `vq/state/task-ledger.json`;
`quality-gates-preflight.test.ts:147` skaito realų `vq/config/*`; `migration-coverage-ledger`
„įrodymas" = eilutės ilgis ≥ 40; korpuso vartai (`domain-tasks-etalonas-rules:321`,
`markdown-readers-real-corpus:26`) be `length > 0` sargo — praeina vakuume;
`docs-retired-names` `retired-name-ok` žymė išjungia vartą; CSS vartas `.x {}` = „padengta";
i18n vartas mato tik `t("…")`; `gate-install-covers-smoke` sąrašą importuoja iš testuojamo
`smoke.ts`; fake `fingerprint: fp:<length>` — to paties ilgio versijos = „nepakitęs".

---

## Miręs kodas (turi kvietėją tik teste arba visai neturi)

- **Nesuvielinti mechanizmai:** `waitForOwnStopBridgeDone` (kelias negyvas per env), `quarantineStaleDist`,
  `reconcilePreservedRefs`, `applyIntegrationPlan`/`createIntegrationBranch`/`appliedSourceCommits`
  (IVER grandinė), `createIntegrationPlan`+`integrationBranchName`/`assessIntegrationRisk`,
  `runWaveGates`/`selectWaveTests`/`computeWaveSourceHash`, `decideRetryOrRepair`,
  `decideHumanReviewEscalation`, `createIntegrationRepair`/`writeRepairPrompt` (`repairScope`
  nepaduoda niekas → `repair-required` visada parkuoja), `appendStateHistory` (→
  `resolveHumanReviewStatus` niekada `"resolved"`), `uiRebuildStatus`, `identityFingerprint`,
  `hookPostBashSync`/`evaluatePostBashSync`/`buildPostToolUseHookOutput`, `isDistRebuildCommand`,
  `isMaintenancePath`, `measureParallelOverhead` (pats prašosi trinamas),
  `claudeAdapterDispatch`/`buildAdapterExecutionRequest`, `createExecutionAdapterIntegrationReviewer`,
  `readContextCacheEntries`, `getAdapterCapabilityDeclaration`, `api.resumeLoop`/`POST /tasks/resume`.
- **Negyvos šakos:** `command.ts:94-98` `already-running`; `ui-router-mutations.ts:82` 413;
  `etalonas-rules.ts:118` `!startsWith("ui-app/")`; `arrest.ts:187-190` `=== null`;
  `benchmark-evidence-check.ts:120-125`; `WorkerPoolResolution.continuing/succeeded_task_ids/
  failed_task_ids/integration_ready`.
- **Miręs konfigas:** `AG_ROLLBACK_CLEAN`, `CLAUDE_COMMAND` (env), `mcp-policy.json`,
  `browser-policy.json`, `research-policy.json`, `vq/schemas/*.schema.json`,
  `context-compression.json` vėliavos (visos `false`).
- **Dublikatai:** `wildcardPatternMatches` ×2, `SCOPE_LOCK_KINDS` ×2, runtime prefiksų sąrašai ×2,
  `ReleaseCheckFsPort` ×2, flag parseriai ×4, „source change" šablonai ×2, „LLM kvietimo"
  apibrėžimai ×2, `smokePorts.commandExists` vs `run-process.commandExists`.
- **dead-export-gate KNOWN sąrašo įrašai su nebegaliojančia priežastimi:** `readTokenAnalyticsSnapshot`,
  `auditBacklogDirectory`, `ecmascriptExtensions`; FORWARD: `pruneScopeLocks`,
  `EMPTY_SCOPE_LOCK_REGISTRY`, `compareRoutingTier`, `normalizeEnforcementLevel`,
  `renderCompactWorkerDslWhenEnabled`, `dispatchMcpCapabilitiesFromOfferedTools` — priežastis
  „etalone irgi be kvietėjo" yra paritetas, ne poreikis.

---

## Ką daryti pirmiausia

1. **P0-1** `rollback-stable`: atmesti nežinomus argumentus (exit 2) ir arba įgyvendinti `--ref`,
   arba ištrinti jį iš registro/README. Vienas vakaras, uždaro duomenų praradimo kelią.
2. **L1** stop-bridge: nonce koordinatoriui perduoti per attempt būseną (`claude-stop-status.json`
   jau jį neša), ne per savo env. Tada `COORDINATOR STOP WAIT RESULT` pasirodys žurnale — tai ir
   yra patikros kriterijus.
3. **L2** `loop` startas kviečia `evaluateLoopPreconditions` (kaip `loop-guard`); stale dist → exit 78.
4. **D1** `wildcardPatternMatches`: `**/` → `(?:.*/)?`; ištrinti antrą kopiją `scope-lock-rules.ts`.
5. **I1** `clearStaleIndexLock` per `git rev-parse --git-dir`.
6. **L3** `applySplitSupersede` — po `done` kaskados nekviesti (arba kaskadą riboti human-review/failed).
7. **L6** worktree harvest: `task-ledger.json` merge, `retry-counts`/`last-error-signatures`
   raktinti per task'ą pirminiame medyje, `task-events.jsonl` append.
8. **A1** broad-scope regex → tas pats `matchesAllowedPath` apibrėžimas („kelias dengia > N failų").
9. **T1** dead-export-gate: `export { }`, testinius kvietėjus skaičiuoti atskirai (jie neturi
   prikelti), validuoti `KNOWN_*` žodyną. Tada išlįs visas aukščiau minėtas miręs sąrašas.
10. **U2** porto zondas per HTTP GET `/api/identity` kaip etalone.
11. **Dk1/Dk3** ištaisyti getting-started auto-push teiginį ir 6 agentų failų kelius
    (`vq/project/profile.json`, `vq/logs/commit-msg.md`) — tai keičia realų loop'o elgesį
    (commit žinutės).
12. **CLI C1–C7** — arba handleriai, arba README/registras; `readiness-audit` išplėsti iki usage eilutės.

## Ko auditas neapėmė

`mobile-gateway`, `mobile-app`, `AG/benchmark` paketai (ne `pnpm test` dalis). Etalono
(`D:\React\AG_loop`) palyginimas — tik ten, kur auditorius pats atsivertė (D3, U2, PG-2).
Runtime būsena `vq/state` — skaityta tik `orchestrator.log` (L1) ir `git-automation-policy.json`
(Dk1). Pilnos auditorių ataskaitos su visais P2/P3 ir „patikrinta, švaru" sąrašais — sesijos
scratchpad'e (`audit-{domain,loop-core,application,infrastructure,cli,hooks,ui,composition,docs,tests}.md`),
į repo neperkeltos.
