// application/quality-gates barrel — re-exports only (MOD-1).
//
// VQ-302 atnešė preflight-rules (grynoji pusė), VQ-304 — preflight-memo-schema, VQ-305 —
// gates-memo + quality-gates + preflight (su architektūros/enforcement vartais) +
// security-verify + spec-drift. Deterministinės diagnozės taisyklės — domain/diagnosis
// (dispositions + stream-log logHasAlreadyImplementedMarker); klasteris E3 apimtimi PILNAS.
export * from "./preflight-rules.js";
// E5 VQ-501 (2/5-b): TOK-01 deterministinis preflight fast-path (etalono
// deterministic-preflight 1:1) — veidrodinis domain/diagnosis dispositions greitkeliui.
export * from "./preflight-fastpath.js";
export * from "./preflight-memo-schema.js";
export * from "./quality-gates-status.js";
export * from "./gates-memo.js";
export * from "./quality-gates.js";
export * from "./preflight.js";
export * from "./security-verify.js";
export * from "./spec-drift.js";
