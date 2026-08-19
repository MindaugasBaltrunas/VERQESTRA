// domain/tool-results barrel — re-exports only (MOD-1). Digest variklis suskaidytas į
// digest/ (model/scan/extraction/parsers/render/safety/orkestratorius) pagal WBR VQ-204;
// hook envelope (PostToolUseHookOutput) — E5, log segmentų konstantos — E3/E4.
export * from "./bash-command-class.js";
export * from "./bash-tool-response.js";
export * from "./digest/model.js";
export * from "./digest/bash-output-digest.js";
export * from "./digest/render.js";
export * from "./bash-output-replacement.js";
export * from "./replacement-telemetry.js";
export * from "./shadow-telemetry.js";
