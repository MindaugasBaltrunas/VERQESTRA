// interfaces/hooks barrel — re-exports only (MOD-1).
// E5 VQ-502 (1/6): hook protokolo pamatas — protocol (payload parsinimas su fail-closed
// strict forma PreToolUse guard'ams, HookIo/HookFsPort/HookStdinPort portai), session-changes
// (sesijos apimties nuotrauka, pergyvenanti Stop hook'o changes.log valymą), user-prompt
// (vienkartinis konteksto blokas) ir log-rotation (latestStatus + rotacija).
export * from "./protocol.js";
export * from "./session-changes.js";
export * from "./user-prompt.js";
export * from "./log-rotation.js";
// E5 VQ-502 (2/6): guard'ų protokolo pusė — secret-scan (fail-closed politikos vartai,
// gitignore filtras) ir file-line-guard (bendras per-failą skeletas; taisyklės — domain).
export * from "./secret-scan.js";
export * from "./file-line-guard.js";
// E5 VQ-502 (4/6-a): produkto formos guard'ai (backend/frontend/mobile) ir PostToolUse
// fan-out, kuris NIEKADA neblokuoja — blokavimas paliktas Stop hook'ui.
export * from "./scope-guards.js";
export * from "./post-write-guards.js";
