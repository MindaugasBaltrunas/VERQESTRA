// release-readiness use case (etalono milestone-check.ts, WBR VQ-305): sukomponuoja
// milestone kokybės vartus, aktyvaus spec change išlygiavimo patikrą ir lokalią security
// politiką į vieną milestone verdiktą ir persistuoja jį per portą
// (`vq/state/milestone-check-result.json`). Etalono default runner'iai kviesdavo realius
// use case'us tiesiogiai — VERQESTRA runner'ius (jau su savo portais suvyniotus) paduoda
// composition (E5), tad šis modulis lieka be jokio IO.
import path from "node:path";
import type { QualityGatesStatus } from "../quality-gates/quality-gates-status.js";
import type { SecurityVerifyResult } from "../quality-gates/security-verify.js";
import type { SpecDriftResult } from "../quality-gates/spec-drift.js";

export type MilestonePartStatus = "ok" | "warning" | "failed" | "skipped";

export type MilestoneCheckResult = {
  status: "ok" | "failed";
  quality: { status: MilestonePartStatus; result: QualityGatesStatus };
  spec_alignment: { status: MilestonePartStatus; change_id?: string; result?: SpecDriftResult };
  local_policy: { status: MilestonePartStatus; result: SecurityVerifyResult };
  failed_parts: string[];
  result_path: string;
  updated_at: string;
};

export type MilestoneCheckRunners = {
  quality: () => Promise<QualityGatesStatus>;
  specAlignment: (changeId: string) => Promise<SpecDriftResult>;
  localPolicy: (files: string[]) => Promise<SecurityVerifyResult>;
};

export type MilestoneCheckPorts = {
  /** Aktyvaus spec change id (`vq/spec/changes/<id>/spec.json` su `status: "active"`), jei yra. */
  activeChangeId(): Promise<string | undefined>;
  writeResult(result: MilestoneCheckResult): Promise<void>;
};

export type RunMilestoneCheckOptions = {
  now?: Date;
};

/** `vq/state/milestone-check-result.json` — verdikto failas (rašo adapteris). */
export function milestoneCheckResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "milestone-check-result.json");
}

export async function runMilestoneCheck(
  ports: MilestoneCheckPorts,
  runners: MilestoneCheckRunners,
  options: RunMilestoneCheckOptions = {},
): Promise<MilestoneCheckResult> {
  const activeChangeId = await ports.activeChangeId();
  const qualityResult = await runners.quality();
  const specResult = activeChangeId ? await runners.specAlignment(activeChangeId) : undefined;
  const policyResult = await runners.localPolicy(specResult?.files ?? []);
  const qualityStatus: MilestonePartStatus = qualityResult.passed ? "ok" : "failed";
  const specStatus: MilestonePartStatus = !specResult
    ? "skipped"
    : specResult.status === "ok"
      ? "ok"
      : specResult.status === "warning"
        ? "warning"
        : "failed";
  // security-verify grąžina "blocked" ir tada, kai neturi ką skenuoti (nėra pakeistų failų —
  // pvz. švarus commit'intas medis milestone metu). Toks "blocked" be jokių realių findings
  // yra tuščias scope, ne saugumo klaida, todėl žymim "skipped", kad nebūtų klaidingai
  // griaunamas milestone/release-check. Realus blokas (blocked_paths arba text_findings)
  // lieka "failed".
  const policyEmptyScan =
    policyResult.files.length === 0 &&
    policyResult.blocked_paths.length === 0 &&
    policyResult.text_findings.length === 0;
  const policyStatus: MilestonePartStatus =
    policyResult.status === "ok"
      ? "ok"
      : policyResult.status === "warning"
        ? "warning"
        : policyEmptyScan
          ? "skipped"
          : "failed";
  const parts = { quality: qualityStatus, spec_alignment: specStatus, local_policy: policyStatus };
  const failedParts = Object.entries(parts)
    .filter(([, status]) => status === "failed")
    .map(([name]) => name);
  const result: MilestoneCheckResult = {
    status: failedParts.length === 0 ? "ok" : "failed",
    quality: { status: qualityStatus, result: qualityResult },
    spec_alignment: {
      status: specStatus,
      ...(activeChangeId === undefined ? {} : { change_id: activeChangeId }),
      ...(specResult === undefined ? {} : { result: specResult }),
    },
    local_policy: { status: policyStatus, result: policyResult },
    failed_parts: failedParts,
    result_path: "vq/state/milestone-check-result.json",
    updated_at: (options.now ?? new Date()).toISOString(),
  };
  await ports.writeResult(result);
  return result;
}
