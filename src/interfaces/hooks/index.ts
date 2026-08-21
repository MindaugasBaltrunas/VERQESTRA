// interfaces/hooks barrel — re-exports only (MOD-1).
// E5 VQ-502 (1/6): hook protokolo pamatas — protocol (payload parsinimas su fail-closed
// strict forma PreToolUse guard'ams, HookIo/HookFsPort/HookStdinPort portai), session-changes
// (sesijos apimties nuotrauka, pergyvenanti Stop hook'o changes.log valymą), user-prompt
// (vienkartinis konteksto blokas) ir log-rotation (latestStatus + rotacija).
export * from "./protocol.js";
export * from "./session-changes.js";
export * from "./user-prompt.js";
export * from "./log-rotation.js";
