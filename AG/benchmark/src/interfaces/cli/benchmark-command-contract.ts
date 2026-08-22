/**
 * The CLI surface of the benchmark package (BENCH-10), as one module.
 *
 * `src/index.ts` exports this file, so everything a host CLI needs — the command
 * names, the exit codes, the argument contract, the runner and the composition
 * root — is reachable from the package barrel without a deep import. Consumers
 * import `@ag-loop/benchmark`; the file layout behind this module is an
 * implementation detail they must not depend on.
 *
 * The pieces live in separate modules because they have separate audiences: the
 * exit codes are read by CI and the release gate, the argument contract by the
 * parser tests, the runner by the orchestrator, the composition root by nothing
 * at all except the entry point, and the offline smoke by the pull-request
 * workflow of BENCH-12.
 */
export * from "./benchmark-exit-codes.js";
export * from "./benchmark-cli-arguments.js";
export * from "./benchmark-cli-help.js";
export * from "./benchmark-cli.js";
export * from "./benchmark-cli-composition.js";
export * from "./offline-smoke.js";
