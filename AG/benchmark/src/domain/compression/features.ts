/**
 * The compression feature registry, restated (task 0029).
 *
 * `src/application/context-pack/effective-compression-policy.ts` is the single source of
 * truth for these flag names, and it is an orchestrator internal: BENCH-1 lets
 * this package use documented AG contracts and forbids treating an internal
 * module as an unofficial API, so the five flags are restated here as literals
 * rather than imported. Restating creates exactly one hazard — the two lists
 * drifting apart — and that hazard is held from the side that *may* import the
 * policy module, by `src/tests/characterization-compression-policy.test.ts`.
 *
 * The flag *values* stay snake_case, spelled exactly as `vq/config/context-compression.json`
 * writes them, because a stored sample naming `worker-task-ir` could not be
 * matched against a config naming `worker_task_ir` without a translation table
 * nobody would keep correct. Variant ids are kebab-case for the opposite reason:
 * they are stored on samples and validated against the package's identifier
 * pattern.
 *
 * {@link CONTEXT_COMPRESSION_REGISTRY_VERSION} is copied from that config's
 * `version` field and rides inside every variant identity, so a registry change
 * — a flag added, removed or given another meaning — produces different variant
 * identities instead of silently re-labelling measurements taken under the old
 * registry.
 */

/** The `version` of `vq/config/context-compression.json` these flags were copied from. */
export const CONTEXT_COMPRESSION_REGISTRY_VERSION = 1;

/**
 * The five canonical compression flags, in the orchestrator's schema order.
 *
 * "Compiled prompt" and "Bash digest handler" are deliberately absent: the first
 * is the combination `{worker_task_ir, compact_dsl}` and the second is the
 * `bash_output_digest` flag reached through a hook settings file, so both are
 * configurations of these five rather than flags of their own. Modelling them as
 * extra flags would invent registry entries the orchestrator does not have.
 */
export const COMPRESSION_FEATURES = [
  "worker_task_ir",
  "compact_dsl",
  "symbol_slices",
  "bash_output_digest",
  "dispatch_tool_schema",
] as const;

export type CompressionFeature = (typeof COMPRESSION_FEATURES)[number];

/**
 * How the hook layer was wired while a variant ran.
 *
 * `bash_output_digest` gates two observably different paths: a shadow observer
 * that can only watch a tool result, and a synchronous replacement path that
 * takes effect only when a hook settings file points at it. Same flag, different
 * behaviour, so the wiring is part of a variant's identity rather than a note
 * beside it — otherwise two runs measuring different things would fold into one
 * population.
 */
export const COMPRESSION_HOOK_PROFILES = ["unwired", "bash-digest-handler"] as const;

export type CompressionHookProfile = (typeof COMPRESSION_HOOK_PROFILES)[number];
