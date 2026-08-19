// Pure project-mode classification rules. This is a low domain layer: no node/FS/process/git
// imports and no side effects — only the value types and the total function that maps a set of
// already-gathered workspace signals onto a project mode. The FS-reading adapter (E4
// infrastructure) gathers the signals and delegates the decision here.
// Behaviour etalon: AG_loop domain/project/mode.ts.

/** Which lifecycle situation the project is in, decided from workspace signals. */
export type ProjectMode = "new_project" | "existing_project" | "extend_project" | "repair_project";

/** Confidence the classifier has in the chosen {@link ProjectMode}. */
export type ProjectModeConfidence = "high" | "medium" | "low";

/**
 * Side-effect-free snapshot of the workspace the classifier reasons over. The adapter reads the
 * filesystem to fill these fields; the domain never touches disk.
 */
export type ProjectModeSignals = {
  hasAgWorkspace: boolean;
  productMarkers: string[];
  sourceFiles: string[];
  openSpecChanges: string[];
  queuedTasks: number;
  interruptedTasks: number;
  humanReviewTasks: number;
  repairPrompts: number;
};

/** The classifier's verdict: the mode, how sure it is, why, and the signals it saw. */
export type ProjectModeDetection = {
  mode: ProjectMode;
  confidence: ProjectModeConfidence;
  reasons: string[];
  signals: ProjectModeSignals;
};

/**
 * Maps workspace {@link ProjectModeSignals} onto a {@link ProjectModeDetection}. Precedence:
 * repair evidence (interrupted tasks or repair prompts) wins first; then product evidence plus
 * planned work means an extend; product evidence alone means an existing project; otherwise it is
 * a new project, whose confidence rises when an AG workspace already exists.
 */
export function classifyProjectMode(signals: ProjectModeSignals): ProjectModeDetection {
  const hasProductEvidence = signals.productMarkers.length > 0 || signals.sourceFiles.length > 0;
  const hasPlannedWork = signals.queuedTasks > 0 || signals.openSpecChanges.length > 0;
  const hasRepairEvidence = signals.interruptedTasks > 0 || signals.repairPrompts > 0;

  if (hasRepairEvidence) {
    return detection("repair_project", "high", signals, [
      "interrupted or repair state exists",
      ...productReason(hasProductEvidence),
    ]);
  }

  if (hasPlannedWork && hasProductEvidence) {
    return detection("extend_project", "high", signals, [
      "existing product evidence plus queued or OpenSpec work",
      ...productReason(hasProductEvidence),
    ]);
  }

  if (hasProductEvidence) {
    return detection("existing_project", signals.hasAgWorkspace ? "high" : "medium", signals, [
      "product source or framework markers exist",
      ...workspaceReason(signals.hasAgWorkspace),
    ]);
  }

  if (signals.hasAgWorkspace && hasPlannedWork) {
    return detection("new_project", "medium", signals, [
      "AG workspace has planned work but no product source markers yet",
    ]);
  }

  return detection("new_project", signals.hasAgWorkspace ? "high" : "medium", signals, [
    "no product source markers detected",
    ...workspaceReason(signals.hasAgWorkspace),
  ]);
}

function detection(
  mode: ProjectMode,
  confidence: ProjectModeConfidence,
  signals: ProjectModeSignals,
  reasons: string[],
): ProjectModeDetection {
  return { mode, confidence, reasons, signals };
}

function productReason(hasProductEvidence: boolean): string[] {
  return hasProductEvidence ? ["product source evidence detected"] : ["no product source evidence detected"];
}

function workspaceReason(hasAgWorkspace: boolean): string[] {
  return hasAgWorkspace ? ["AG workspace detected"] : ["AG workspace not detected yet"];
}
