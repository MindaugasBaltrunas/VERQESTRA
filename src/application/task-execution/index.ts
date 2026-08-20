// application/task-execution barrel — re-exports only (MOD-1).
//
// Klasterio sudėtis (WBR VQ-304): queue task selection, bucket state-transition helpers,
// retry-cap + repair-routing decision, human-review escalation decision, dispatch adapter
// routing, pre-dispatch work-evidence gate, dispatch/verify/repair use case'ai ir
// auto-OpenSpec archyvavimas. Kanoninis koordinatorius (`run-coordinator.ts`) atkeliauja
// VQ-304 (2/3) — jo paviršius bus eksportuotas eksplicitiškai čia.
//
// Wiring pastaba (perkelta iš etalono): retry-repair ir human-review-escalation yra CLI-free
// MODELIAI sprendimų, kuriuos kanoninis loop'as daro per savo subprocess vartus — jie
// SĄMONINGAI nejungiami į kanoninį kelią (dubliuotų tuos pačius vartus), bet duoda tai
// logikai tiesiogiai unit-testuojamą namą. adapter-routing yra VIENAS kanoninis routing
// servisas abiem dispatch keliams; task-selection/bucket-transition — loop'o įėjimo taškai.
export * from "./bucket-transition.js";
export * from "./task-selection.js";
export * from "./retry-repair.js";
export * from "./human-review-escalation.js";
export * from "./adapter-routing.js";
export * from "./run-coordinator-ports.js";
export * from "./run-coordinator-guards.js";
export * from "./task-run-state.js";
export * from "./dispatch-task.js";
export * from "./verify-task.js";
export * from "./repair-task.js";
export * from "./openspec-archive.js";

// Sankcionuotas interfaces → application → domain tiltas (tas pats šablonas kaip
// evaluateRepeatedErrorEscalation šiame klasteryje): interfaces sluoksnis kanoninį bucket
// rinkinį ima per šį barrel'į, o ne tiesiogiai iš domain/tasks/buckets.ts.
export { taskBuckets, type TaskBucket } from "../../domain/tasks/buckets.js";

// Tas pats sankcionuotas tiltas diagnozės prompt'o taisyklėms: diagnozės CLI log digest'ą
// ima per šį barrel'į, o ne tiesiogiai iš `domain/diagnosis/log-digest.ts`.
export {
  DIAGNOSIS_DIGEST_LIMITS,
  digestClaudeStreamLog,
  digestQualityGatesLog,
  retryCountsForTask,
} from "../../domain/diagnosis/log-digest.js";

// Pre-dispatch work-evidence vartai (etalono task 1187) — grynoji taisyklė eksportuojama
// atskirai (per `export *` aukščiau), kad jos deterministiškumą būtų galima tikrinti be viso
// port'ų rinkinio.
