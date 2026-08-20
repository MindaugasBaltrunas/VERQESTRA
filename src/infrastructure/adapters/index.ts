// infrastructure/adapters barrel + fabrikas (etalonas: AG_loop infrastructure/adapters).
// Domain ExecutionAdapter porto implementacijos: procesų egzekucija, fs prielaidų
// validacija ir išvesties normalizacija gyvena čia, kad pats portas liktų grynas.

export * from "./adapter-runtime.js";
export * from "./process-runner.js";
export * from "./dry-run-adapter.js";
export * from "./codex-adapter.js";
export * from "./claude-adapter.js";
export * from "./integration-reviewer.js";
export * from "./claude-decision.js";
export * from "./claude-usage.js";
export * from "./claude-tool-schema.js";
export * from "./claude-headless.js";
// E4 VQ-404 (2/2): provider tier -> modelio ID mapping'as (claude-model-env), matomas
// PowerShell dispatch paleidiklis su nonce watchdog'u (claude-launcher), adapterių
// galimybių deklaracijos ir realus IntegrationPort (IVER-3 pilnoji pusė).
export * from "./claude-model-env.js";
export * from "./claude-launcher.js";
export * from "./adapter-capabilities.js";
export * from "./integration-review-adapter.js";
// E5 VQ-501 (2/5-d): dispatch pristatymo pusė (POSIX CLI argumentai + prompt delivery +
// 0028 tool schemų profilis) ir dviejų kanalų sesijos log rašytojas (2026-08-09 EBUSY).
export * from "./claude-dispatch-delivery.js";
export * from "./claude-last-log.js";
// E5 VQ-501 (2/5-e): mid-dispatch token biudžeto watchdog'as (1203/1215/1222) — gyvas
// stream meter'is + Windows log tailer'is; billable formulė — domain/tokens (FQC-12).
export * from "./mid-dispatch-budget.js";
// E5 VQ-501 (2/5-f): dispatch proceso paleidimas (Windows launcher + POSIX stdin su
// nonce langu ir CLI fallback'u), baigties normalizavimas (1213 stop-wait + 1203 budget
// verdiktai), terminaliniai artefaktai/matavimai ir CTX-2 adapterio kelias.
export * from "./execution-adapter-factory.js";
export * from "./claude-dispatch-process.js";
export * from "./claude-dispatch-outcome.js";
export * from "./claude-dispatch-finalize.js";
export * from "./adapter-dispatch.js";

// Fabrikas gyvena execution-adapter-factory.ts (iškeltas dėl acyclic gate — E5 VQ-501
// 2/5-f adapter-dispatch jį importuoja be barrel'io); čia lieka tik re-eksportas.
export { createExecutionAdapter } from "./execution-adapter-factory.js";
