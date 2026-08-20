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
