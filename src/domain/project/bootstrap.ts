// Pure bootstrap-eligibility rules. This is a low domain layer: no node/FS/process/git imports
// and no side effects — only the value types and the total function that decides whether a
// project is eligible for architecture bootstrap from already-gathered evidence. The FS-reading
// adapter (E4 infrastructure) collects the evidence and delegates the decision here.
// Behaviour etalon: AG_loop domain/project/bootstrap.ts; renderBootstrapEligibility (žmogui
// skirtas tekstas) čia NEmigruoja — jis yra pateikimo forma ir keliasi į E5 interfaces (WBR VQ-204).

/** Task buckets that must all be empty for a project to be bootstrap-eligible. */
export const bootstrapCheckedBuckets = [
  "queue",
  "active",
  "delegated",
  "error",
  "failed",
  "human-review",
] as const;
export type BootstrapCheckedBucket = (typeof bootstrapCheckedBuckets)[number];

/**
 * Side-effect-free snapshot of what the workspace looks like for bootstrap purposes. The adapter
 * reads the filesystem to fill these fields; the domain never touches disk.
 */
export type BootstrapEvidence = {
  bucketsEmpty: boolean;
  hasReadme: boolean;
  mmdSources: string[];
};

/** The bootstrap verdict: the evidence plus the derived eligibility flag. */
export type BootstrapEligibility = BootstrapEvidence & {
  bootstrapEligible: boolean;
};

/**
 * A project is bootstrap-eligible only when every checked task bucket is empty, a non-empty
 * README exists, and at least one Mermaid (`.mmd`) architecture source is present — i.e. there is
 * nothing queued yet but there is enough seed material to generate the initial architecture.
 */
export function evaluateBootstrapEligibility(evidence: BootstrapEvidence): BootstrapEligibility {
  return {
    ...evidence,
    bootstrapEligible: evidence.bucketsEmpty && evidence.hasReadme && evidence.mmdSources.length > 0,
  };
}
