// application/task-execution barrel — re-exports only (MOD-1).
//
// Klasterio sudėtis (WBR VQ-304): queue task selection, bucket state-transition helpers,
// retry-cap + repair-routing decision, human-review escalation decision, dispatch adapter
// routing, pre-dispatch work-evidence gate, dispatch/verify/repair use case'ai,
// auto-OpenSpec archyvavimas ir kanoninis koordinatorius (`run-coordinator.ts`, skaidytas į
// model/terminal/cheap-finish/integration modulius pagal 500 eil. gate). Koordinatoriaus
// vidiniai moduliai (terminal/cheap-finish/integration) per barrel'į NEeksportuojami —
// composition root'ui (E5) reikia tik `createRunCoordinator` paviršiaus, kaip etalone.
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

// Kanoninis koordinatorius — eksplicitus paviršius (ports/guards/state jau eksportuoti
// aukščiau, tad iš `run-coordinator.ts` imamas tik jo paties indėlis).
export { createRunCoordinator } from "./run-coordinator.js";
export type { RunCoordinator, RunCoordinatorOptions } from "./run-coordinator-model.js";

// VQ-304 (3/3) — etalono orchestrator/tasks likutis: skaidymo planas, vaikų enqueue,
// TaskGraph importas + blocked maršrutizavimas, repair prompt scope taisyklės, ledger'io
// sprendimo taisyklės ir task-events kontraktas. Dydžio matavimas — domain/tasks/size (FQC-12).
export * from "./task-splitting.js";
export * from "./enqueue-child-tasks.js";
export * from "./task-graph-import.js";
export * from "./repair-prompt.js";
export * from "./task-ledger-rules.js";
// E5 VQ-501: ledger operacijos virš store porto (clear + sync taisyklės iš CLI į application)
// ir retry skaitiklių mutacija su store portu (retry-guard CLI + retry-repair bendras kelias).
export * from "./task-ledger-service.js";
export * from "./retry-counts.js";
export * from "./task-events-model.js";
// E4 VQ-402 (1/2): Stop staging'o grynos taisyklės (task 890/1100/0016) — vykdymas E5 hooks.
export * from "./session-staging.js";

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

// E5 VQ-501 (2/5-c): tie patys sankcionuoti tiltai diagnozės CLI adapteriui — grynos
// domain/diagnosis dispozicijos ir git changes taisyklės per šį barrel'į.
export {
  evaluateDeterministicDone,
  evaluateLocalDiagnosis,
  pendingAttemptChangedFiles,
  resolveDispatchSessionNonce,
  resolveEffectiveStopStatus,
  type EffectiveStopStatus,
  type StopEvidence,
  type StopEvidenceOrigin,
} from "../../domain/diagnosis/dispositions.js";
export { logHasAlreadyImplementedMarker } from "../../domain/diagnosis/stream-log.js";
export { nonRuntimeDirtyEntriesFromStatus, sessionScopedChangedFiles } from "../../domain/git/changes.js";
// E5 VQ-501 (2/5-c): session-write nuosavybės taisyklė (etalono hooks/session-staging
// ownership pusė) — IO adapteriai VQ-502.
export * from "./session-write-owners.js";
// E5 VQ-501 (2/5-d): execution context vartai + kanoninio worker prompt'o gamyba (CTX-2;
// bendra CLI dispatch ir adapterio keliui — negali išsiskirti tarp paviršių).
export * from "./execution-context-gate.js";
// E5 VQ-501 (2/5-e): stop-bridge laukimo/zero-usage grynos taisyklės (1213/1218 su
// DispatchUsageView struktūrine forma) ir execution-result įrašo statyba (1117a).
export * from "./stop-bridge-wait.js";
export * from "./dispatch-execution-record.js";
// E5 VQ-501 (3/5-b): openspec-reconcile — 0030 batch suderinimas virš openspec-archive
// taisyklių (OpenSpecReconcileFsPort = archyvavimo portas + katalogų enumeracija).
export * from "./openspec-reconcile.js";

// Pre-dispatch work-evidence vartai (etalono task 1187) — grynoji taisyklė eksportuojama
// atskirai (per `export *` aukščiau), kad jos deterministiškumą būtų galima tikrinti be viso
// port'ų rinkinio.
export * from "./session-baseline.js";
