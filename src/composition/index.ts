// composition/ barrel — re-exports only (MOD-1). Kompozicija yra vienintelis sluoksnis, kuris
// mato visus kitus; ji nieko neeksportuoja žemyn.
// E5 VQ-504 (1/N): runtime šaknys, Node adapteriai, CLI registras ir dispatch'as.
export * from "./runtime-context.js";
export * from "./node-adapters.js";
export * from "./cli-registry.js";
export * from "./cli-main.js";
