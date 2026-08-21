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
// E5 VQ-502 (4/6-b): package/lockfile ir migracijų guard'ų adapteriai virš grynų sprendimų.
export * from "./package-guard.js";
export * from "./migration-guard.js";
// E5 VQ-502 (5/6-a): PreToolUse vartai — vienintelė vieta, galinti blokuoti įrankio kvietimą.
export * from "./runtime-ownership.js";
export * from "./pre-hooks.js";
// E5 VQ-502 (5/6-b): ledger'io lock protokolas ir jo rašytojai — vienintelė vieta, kur
// serializuojami lygiagrečių sesijų įrodymų įrašai.
export * from "./ledger-lock.js";
export * from "./session-write-ledger.js";
// E5 VQ-502 (5/6-c): PostToolUse pusė — bendras kontekstas, Bash/Read hook'ai ir rašymo
// hook'as. Visi grąžina 0: PostToolUse exit 2 yra blokuojantis kodas.
export * from "./post-hook-context.js";
export * from "./post-hooks.js";
export * from "./post-write.js";
// E5 VQ-502 (6/6-a): sesijos/loop runtime įrašo saugykla (taisyklės — domain/scheduling).
export * from "./loop-runtime-store.js";
// E5 VQ-502 (6/6-b): sesijos ciklas — SessionStart vartai (trys nepriklausomi reset'o
// stabdžiai) ir SessionEnd.
export * from "./session-hook-context.js";
export * from "./session-start.js";
export * from "./session-end.js";
// E5 VQ-502 (6/6-c): Stop pre-commit guard'ai — vienintelė guard'ų klasė, kuri BLOKUOJA.
export * from "./stop-guards.js";
// E5 VQ-502 (6/6-d): Stop hook'as — vienintelė vieta, automatiškai commit'inanti sesijos darbą.
export * from "./on-stop-context.js";
export * from "./on-stop.js";
// E5 VQ-502 (6/6-e): sesijos santrauka — ataskaita, kuri niekada neblokuoja.
export * from "./session-summary.js";
