// application/architecture barrel — re-exports only (MOD-1).
// E5 VQ-501 (3/5-c): architektūros mazgų orkestracijos IO pusė virš domain/architecture
// taisyklių — ports (ArchitectureStateFsPort + NodeProgressStorePort), evidence-ledger
// (JSONL append/read), task-synthesizer (grynas markdown renderis + persist),
// node-verifier (verifyNode per portus; repair sprendimai — domain repair-policy).
export * from "./ports.js";
export * from "./evidence-ledger.js";
export * from "./task-synthesizer.js";
export * from "./node-verifier.js";
// E5 VQ-501 (3/5-d): wave variklis — implementation-detector (node-map + label
// heuristikos per portą), wave-reclaim (895 external/evidence-less atstatymas),
// task-sync (done taskas → mazgo implemented_files + verify + bounded repair),
// wave (markAlreadyImplementedNodes + synthesizeReadyArchitectureWave).
// Governance ir architecture CLI komanda — 3/5-e.
export * from "./implementation-detector.js";
export * from "./wave-reclaim.js";
export * from "./task-sync.js";
export * from "./wave.js";
