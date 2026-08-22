/**
 * `@ag-loop/benchmark` public contract.
 *
 * Everything a consumer may depend on is re-exported here. Deep imports into
 * `domain/`, `application/`, `infrastructure/` or `interfaces/` are not part of
 * the contract, and the AG orchestrator reaches this package only through this
 * barrel (BENCH-1).
 */

export * from "./domain/scenario.js";
export * from "./domain/result.js";
export * from "./domain/metrics.js";
export * from "./domain/compression.js";
export * from "./domain/baseline.js";
export * from "./domain/verdict.js";

export * from "./application/benchmark-api.js";
export * from "./application/ports/scenario-suite-port.js";
export * from "./application/ports/sample-store-port.js";
export * from "./application/ports/worktree-port.js";
export * from "./application/ports/agent-execution-port.js";
export * from "./application/ports/acceptance-verifier-port.js";
export * from "./application/ports/environment-port.js";

export * from "./infrastructure/benchmark-workspace-paths.js";

export * from "./interfaces/cli/benchmark-command-contract.js";
