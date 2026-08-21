// infrastructure barrel — re-exports only (MOD-1).
//
// E4 VQ-401: fs (NodeFsAdapter — vienas adapteris visiems E3 klasterių fs portams +
// win32 rename retry politika), process (spawn runner'is su BoundedOutput/timeout/abort +
// verifikuojamas process-tree kill; isProcessAlive — scheduling processIsAlive tiekėjas),
// runtime-paths (vq/runtime agregato layout'as; attempt tapatybė — iš
// application/scheduling/worker-limits, FQC-12). Laikrodžių portų default'ai
// (systemClock, systemSchedulingClock) jau gyvena prie savo portų application sluoksnyje —
// atskiro adapterio jiems nereikia.
// E4 VQ-402 (1/2): git klientas (core/git 1:1 + currentCommitResolver/gitLogNumstat/
// gitStatusPorcelain tiekėjai), git-automation (commit/push be force, stale index.lock),
// stable-ref (vq/state/stable-ref) ir rollback-scope IO (grynos taisyklės — domain/git).
export * from "./fs/fs-retry.js";
export * from "./fs/node-fs-adapter.js";
export * from "./process/process-tree.js";
export * from "./process/run-process.js";
export * from "./runtime-paths.js";
export * from "./git/git-client.js";
// E5 VQ-504: pakeistų produkto failų sąjunga (git status ∪ changes.log) — E4 adapterio spraga.
export * from "./git/changed-files.js";
export * from "./git/git-automation.js";
export * from "./git/stable-ref.js";
export * from "./git/rollback-scope.js";
// E4 VQ-402 (2/2): worktrees (etalono lifecycle 695 eil. skaidymas: layout, classifier,
// owner/karantinas, provision, removal su Windows ilgo kelio fallback'ais, reaper) +
// branch-integration (vienintelis pirminę šaką stumiantis kelias) + integration-branch
// (plumbing grandinė su laikinu indeksu, CAS update-ref) + build-impact.
export * from "./git/integration-branch.js";
export * from "./git/integration-build-impact.js";
export * from "./git/worktrees/worktree-layout.js";
export * from "./git/worktrees/worktree-state-classifier.js";
export * from "./git/worktrees/worktree-git-util.js";
export * from "./git/worktrees/worktree-owner.js";
export * from "./git/worktrees/worktree-provision.js";
export * from "./git/worktrees/worktree-removal.js";
export * from "./git/worktrees/worktree-reaper.js";
export * from "./git/worktrees/worktree-branch-integration.js";
// E4 VQ-403 (1/2): persistence — runtime attempt store (etalono 656 eil. skaidymas į
// schema/io/store; vq/runtime, tapatybė įrodoma manifestu, write-once + CAS), task-graph
// snapshot store (vq/state/task-graph.json, schema zod prie modulio), code-index store
// (JSONL byte-compat su AG_loop formatu, vq/state/code-index) + code-intelligence fs
// adapteris (atskiras nuo nodeFsAdapter — listDirectory formos konfliktas) ir
// state-history (resolveHumanReviewStatus — FinalAuditPorts tiekėjas).
export * from "./fs/code-intelligence-fs-adapter.js";
export * from "./persistence/runtime-attempt-schema.js";
export * from "./persistence/runtime-artifact-io.js";
export * from "./persistence/runtime-artifact-store.js";
export * from "./persistence/task-graph-store.js";
export * from "./persistence/code-index-store.js";
export * from "./state/state-history.js";
// E4 VQ-403 (2/2): context-cache saugykla (RAG-2 ContextCachePort impl su lazy code-index
// patikra ir talpos ribojimu), attempt rezoliucijos portas + AttemptIdentityPort tiekėjas
// (pilnas resolveris — loop E5), token-usage.jsonl rašytojas su dual-write attempt kopija,
// stop-bridge (no-clobber vartai, attempt-first tvarka) ir session evidencijos tiekėjai
// (ReliabilityPorts sessionWrites/sessionFileKinds).
export * from "./persistence/context-cache-store.js";
export * from "./state/attempt-resolution.js";
export * from "./state/token-usage-log.js";
export * from "./state/stop-bridge.js";
export * from "./state/session-activity.js";
// E4 VQ-404 (1/2): domain ExecutionAdapter porto implementacijos + Claude headless
// klasteris (etalono claude-headless 782 eil. skaidymas: decision/usage/tool-schema/
// headless; result envelope paieška — domain/diagnosis/stream-log, ClaudeUsage —
// state/token-usage-log, FQC-12) + integration reviewer tiltas (IVER-3).
export * from "./adapters/index.js";
// E4 VQ-404 (2/2): repair prompt saugykla (vq/state/repair) ir realūs TokenBudgetGatePorts
// (integration-review-adapter numatytieji efektai); GitHub integracijos (client-injected,
// be tiesioginio HTTP); bootstrap tiekėjai — README intencija, bootstrap detekcija,
// architektūros grafo/progreso saugykla, .mmd -> grafas importas, openspec autogen su
// deterministiniu template fallback'u ir realios BootstrapSpecPorts implementacijos.
export * from "./state/task-repair-store.js";
export * from "./state/token-budget-gate-ports.js";
export * from "./integrations/github-issues.js";
export * from "./integrations/github-pr.js";
export * from "./bootstrap/readme-intent.js";
export * from "./bootstrap/bootstrap-detector.js";
export * from "./bootstrap/architecture-graph-store.js";
export * from "./bootstrap/bootstrap-architecture.js";
export * from "./bootstrap/openspec-autogen.js";
export * from "./bootstrap/bootstrap-spec-ports.js";
