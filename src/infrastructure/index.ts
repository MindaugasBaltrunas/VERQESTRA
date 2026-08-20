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
