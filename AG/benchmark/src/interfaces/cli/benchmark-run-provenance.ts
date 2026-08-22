// Under what methodology a stored run's samples are published (BENCH-8).
//
// Extracted from `benchmark-cli-composition.ts` for two reasons that turned out to be the same
// reason. That file had grown past 800 lines and had no test of its own, and the defect this
// module now guards against had been sitting in it: `baseline create`, `compare` and the
// interactive `report` re-derived a run's identity from the suite as it stands, the host as it is
// now, and the shape of whichever samples survived — publishing one run's numbers under another
// run's methodology.
//
// A composition is hard to test because it constructs its own dependencies. So the dependencies
// are parameters here, and the seam that makes the module testable is the same seam that keeps
// the wiring in one place and the decision in another.

import type { BenchmarkRunSummary } from "../../application/benchmark-api.js";
import type { RunIdentityRecord } from "../../application/ports/run-identity-store-port.js";
import type { BenchmarkIdentity } from "../../domain/baseline.js";
import type { RunEnvironmentRecord } from "../../application/run-environment.js";
import { buildRunConfiguration, buildRunIdentity } from "../../application/run/run-identity.js";
import { computeRunPolicyHash } from "../../application/run/run-policy.js";
import { summarizeSamples } from "../../application/run/run-identity.js";
import { MODE_EXECUTION_PROFILES } from "../../application/ports/execution-plan.js";
import { EXECUTION_MODES, type BenchmarkSample, type ExecutionMode } from "../../domain/result.js";
import type { ScenarioSuite } from "../../domain/scenario.js";

/** What a run's samples are described under, derived from the samples themselves. */
export interface StoredRunShape {
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  readonly allowNetworkModels: boolean;
}

/**
 * The configuration a *stored* ledger is described under, when the ledger recorded nothing.
 *
 * A legacy ledger does not state which modes or how many repetitions produced it, so the
 * description is read from the samples: the modes that actually occur, and the largest repetition
 * index reached.
 *
 * This is a reconstruction and it is lossy in one direction that matters. A run planned as
 * `ag-loop + agent-solo` whose loop cells were all lost reads here as an `agent-solo` run that was
 * planned that way — the missing half disappears from the very field that says what was attempted.
 * That is tolerable only for ledgers written before runs recorded their own identity; for every
 * other ledger the record is authoritative and this function is not consulted.
 */
export function describeStoredRun(samples: readonly BenchmarkSample[]): StoredRunShape {
  const present = new Set(samples.map((sample) => sample.mode));
  const modes = EXECUTION_MODES.filter((mode) => present.has(mode));
  return {
    modes,
    repetitions: samples.reduce((most, sample) => Math.max(most, sample.repetition), 1),
    // A ledger's own samples state whether a networked mode ran; a control-only
    // ledger is a run that needed no permission.
    allowNetworkModels: modes.some((mode) => MODE_EXECUTION_PROFILES[mode].reachesNetwork),
  };
}

/** Everything reading a run's provenance needs, supplied by the composition that owns the wiring. */
export interface RunProvenanceDeps {
  /** The newest run ledger, or `undefined` when no run has been recorded. */
  readonly findLedger: () => Promise<string | undefined>;
  /** The identity that ledger recorded, or `undefined` for a ledger written before records existed. */
  readonly readRecord: (ledgerPath: string) => Promise<RunIdentityRecord | undefined>;
  readonly readSamples: (ledgerPath: string) => Promise<readonly BenchmarkSample[]>;
  /** The frozen suite, needed only on the legacy path. */
  readonly requireSuite: () => Promise<{ readonly suite: ScenarioSuite; readonly suiteHash: string }>;
  /** The host as it is now, needed only on the legacy path. */
  readonly captureRunEnvironment: () => Promise<RunEnvironmentRecord>;
  readonly modeAdapterVersions: Readonly<Record<ExecutionMode, string>>;
  /** How a legacy ledger's re-derived provenance is announced. Never swallowed. */
  readonly warn: (message: string) => void;
  /** Thrown when there is no ledger, or a ledger with no samples. */
  readonly notExecuted: (action: string) => Error;
}

/**
 * The summary the newest run's stored samples add up to, under the provenance that run ACTUALLY
 * recorded.
 *
 * Both reads take the ledger path resolved ONCE, and the record is read before the numbers: a
 * caller that asked for "the latest samples" and "the latest identity" separately would pair one
 * run's samples with another run's identity the moment a run finished between the two calls.
 *
 * Re-derivation survives for exactly one case — a ledger written before runs recorded their
 * identity — because refusing those would make every stored run unreadable at once. A record that
 * exists and is damaged still throws, out of `readRecord`.
 */
export async function loadRecordedSummary(
  deps: RunProvenanceDeps,
  action: string,
): Promise<BenchmarkRunSummary> {
  const ledgerPath = await deps.findLedger();
  if (ledgerPath === undefined) throw deps.notExecuted(action);

  const record = await deps.readRecord(ledgerPath);
  const samples = await deps.readSamples(ledgerPath);
  // A ledger that exists and holds nothing is a run that measured nothing; summarising it would
  // publish zeroes that read as results.
  if (samples.length === 0) throw deps.notExecuted(action);

  const provenance = await resolveProvenance(deps, action, record, samples, ledgerPath);
  return summarizeSamples(samples, provenance.identity, provenance.environment.environment);
}

/**
 * The identity and host a set of samples is published under.
 *
 * Shared by `loadRecordedSummary` and by `verify`, which re-derives ACCEPTANCE for stored samples
 * and must not re-derive their provenance while it does: that would change the second half of the
 * question without being asked to.
 */
export async function loadRecordedProvenance(
  deps: RunProvenanceDeps,
  action: string,
): Promise<{ readonly identity: BenchmarkIdentity; readonly environment: RunEnvironmentRecord }> {
  const ledgerPath = await deps.findLedger();
  const record = ledgerPath === undefined ? undefined : await deps.readRecord(ledgerPath);
  const samples = ledgerPath === undefined ? [] : await deps.readSamples(ledgerPath);
  return resolveProvenance(deps, action, record, samples, ledgerPath);
}

async function resolveProvenance(
  deps: RunProvenanceDeps,
  action: string,
  record: RunIdentityRecord | undefined,
  samples: readonly BenchmarkSample[],
  ledgerPath: string | undefined,
): Promise<{ readonly identity: BenchmarkIdentity; readonly environment: RunEnvironmentRecord }> {
  if (record !== undefined) {
    return { identity: record.identity, environment: record.environment };
  }

  deps.warn(
    `benchmark ${action}: ${ledgerPath ?? "no ledger"} carries no recorded run identity, ` +
      "so its provenance is being re-derived from the suite and host as they stand now; " +
      "a comparison against it is a comparison of assumptions, not of recorded methodology",
  );
  const { suite, suiteHash } = await deps.requireSuite();
  const environment = await deps.captureRunEnvironment();
  const shape = describeStoredRun(samples);
  return {
    identity: buildRunIdentity({
      config: buildRunConfiguration({
        suiteVersion: suite.version,
        modes: shape.modes,
        repetitions: shape.repetitions,
        allowNetworkModels: shape.allowNetworkModels,
        modeAdapterVersions: deps.modeAdapterVersions,
      }),
      suiteHash,
      policyHash: computeRunPolicyHash(),
      agCommit: environment.agCommit,
    }),
    environment,
  };
}

/**
 * The configuration and host a run was recorded under — the other half of its provenance.
 *
 * `loadRecordedSummary` fixes the identity a run's samples are published with; this fixes what
 * `compare` builds the current run's manifest from. Splitting them was the shape of the original
 * defect: `compare` took the hashes from the summary and the configuration and environment from
 * the package as it stands, so a comparison mixed one run's identity with another run's
 * methodology and reported the difference as a suite edit.
 *
 * Falls back for the same single case and says so the same way: a ledger written before runs
 * recorded their identity.
 */
export async function loadRecordedRunContext(
  deps: RunProvenanceDeps,
  action: string,
): Promise<{
  readonly config: ReturnType<typeof buildRunConfiguration>;
  readonly environment: RunEnvironmentRecord;
}> {
  const ledgerPath = await deps.findLedger();
  const record = ledgerPath === undefined ? undefined : await deps.readRecord(ledgerPath);
  if (record !== undefined) {
    return { config: record.config, environment: record.environment };
  }

  const { suite } = await deps.requireSuite();
  const environment = await deps.captureRunEnvironment();
  const samples = ledgerPath === undefined ? [] : await deps.readSamples(ledgerPath);
  const shape = describeStoredRun(samples);
  deps.warn(
    `benchmark ${action}: no recorded run configuration was found, ` +
      "so the current run's manifest is being built from the suite and host as they stand now",
  );
  return {
    config: buildRunConfiguration({
      suiteVersion: suite.version,
      modes: shape.modes,
      repetitions: shape.repetitions,
      allowNetworkModels: shape.allowNetworkModels,
      modeAdapterVersions: deps.modeAdapterVersions,
    }),
    environment,
  };
}

/**
 * The provenance a run being executed RIGHT NOW is recorded under.
 *
 * The mirror image of everything above, and the one place re-derivation is correct: a run
 * happening now really is being taken under the suite as it stands and on the host as it is, and
 * this is where that fact gets written down so every later reader can be told rather than left to
 * guess. Every function above exists to make sure they are told.
 */
export async function describeLiveRun(
  suite: ScenarioSuite,
  suiteHash: string,
  shape: StoredRunShape,
  modeAdapterVersions: Readonly<Record<ExecutionMode, string>>,
  captureRunEnvironment: () => Promise<RunEnvironmentRecord>,
): Promise<{
  readonly environment: RunEnvironmentRecord;
  readonly config: ReturnType<typeof buildRunConfiguration>;
  readonly identity: BenchmarkIdentity;
}> {
  const environment = await captureRunEnvironment();
  const config = buildRunConfiguration({
    suiteVersion: suite.version,
    modes: shape.modes,
    repetitions: shape.repetitions,
    allowNetworkModels: shape.allowNetworkModels,
    modeAdapterVersions,
  });
  return {
    environment,
    config,
    identity: buildRunIdentity({
      config,
      suiteHash,
      policyHash: computeRunPolicyHash(),
      agCommit: environment.agCommit,
    }),
  };
}
