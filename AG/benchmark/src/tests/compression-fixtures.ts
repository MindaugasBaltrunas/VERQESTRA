import type { CompressionVariant } from "../domain/compression/variant.js";
import type {
  AcceptanceVerdict,
  BenchmarkSample,
  CheckStatus,
  SampleCompressionDiagnostics,
} from "../domain/result.js";
import { validSample } from "./sample-fixtures.js";

/**
 * Samples attributed to a compression variant.
 *
 * Every field a compression aggregate reads can be stated; everything else stays
 * at a value the sample validator accepts, so a failing assertion names the rule
 * under test rather than a field a test forgot. The records are deliberately
 * storable: a fixture the ledger would refuse proves nothing about a fold that
 * only ever sees stored samples.
 */

export interface CompressionSampleInput {
  readonly variant: CompressionVariant;
  readonly sampleId?: string;
  readonly verdict?: AcceptanceVerdict;
  /** Input tokens; output stays zero, so a test states one number per sample. */
  readonly tokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly numTurns?: number;
  /** `false` records a run whose accounting failed. Defaults to a captured record. */
  readonly captured?: boolean;
  /** `true` omits the usage block entirely — the shape of a v1 sample or a silent producer. */
  readonly withoutUsage?: boolean;
  readonly repairs?: number;
  readonly humanReviewEvents?: number;
  /** Records a changed file outside the scenario's declared scope. */
  readonly outOfScope?: boolean;
  readonly securityCheck?: CheckStatus;
  readonly diagnostics?: SampleCompressionDiagnostics;
}

let sequence = 0;

function acceptance(verdict: AcceptanceVerdict): BenchmarkSample["acceptance"] {
  return verdict === "verified-accepted"
    ? { verdict, reasons: [], agentClaimedDone: true }
    : { verdict, reasons: ["check-failed"], agentClaimedDone: verdict === "rejected" };
}

export function compressionSample(input: CompressionSampleInput): BenchmarkSample {
  const base = validSample();
  const repairs = input.repairs ?? 0;
  const verdict = input.verdict ?? "verified-accepted";
  sequence += 1;
  const captured = input.captured ?? true;
  return {
    ...base,
    sampleId: input.sampleId ?? `compression-${String(sequence).padStart(4, "0")}`,
    acceptance: acceptance(verdict),
    telemetry: {
      ...base.telemetry,
      inputTokens: input.tokens ?? 0,
      outputTokens: 0,
      // Every repair is itself an attempt after the first, unrepaired one.
      attempts: repairs + 1,
      repairs,
      humanReviewEvents: input.humanReviewEvents ?? 0,
    },
    checks:
      input.securityCheck === undefined
        ? base.checks
        : [
            ...base.checks,
            {
              id: "security-gate",
              kind: "security",
              status: input.securityCheck,
              durationMs: 1_000,
            },
          ],
    workspace:
      input.outOfScope === true
        ? {
            ...base.workspace,
            changedFiles: ["src/session-token.mjs", "src/forbidden.mjs"],
            outOfScopeFiles: ["src/forbidden.mjs"],
          }
        : base.workspace,
    ...(input.withoutUsage === true
      ? {}
      : {
          usage: {
            source: "envelope" as const,
            captured,
            ...(captured && input.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: input.cacheReadInputTokens }
              : {}),
            ...(captured && input.cacheCreationInputTokens !== undefined
              ? { cacheCreationInputTokens: input.cacheCreationInputTokens }
              : {}),
            ...(captured && input.numTurns !== undefined
              ? { numTurns: input.numTurns, turnsSource: "recorded" as const }
              : {}),
          },
        }),
    compression: {
      variantId: input.variant.id,
      variantIdentity: input.variant.identity,
      features: input.variant.features,
      hookProfile: input.variant.hookProfile,
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    },
  };
}

/** `count` identical samples of one variant, for a population a rate can be stated over. */
export function compressionSamples(
  count: number,
  input: CompressionSampleInput,
): readonly BenchmarkSample[] {
  return Array.from({ length: count }, () => compressionSample(input));
}
