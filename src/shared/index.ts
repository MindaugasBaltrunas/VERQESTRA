// shared/ barrel — re-exports only, no logic (see WBR VQ-101). Production code inside
// shared/ imports sibling files directly; outside layers may use either the barrel or
// deep paths — both resolve to the same single implementation.

export * from "./result.js";
export * from "./errors.js";
export * from "./exit-codes.js";
export * from "./json.js";
export * from "./hash.js";
export * from "./markdown.js";
export * from "./paths.js";
export * from "./ids.js";
export * from "./numbers.js";
