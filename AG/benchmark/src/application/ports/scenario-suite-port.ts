import type { ScenarioSuite } from "../../domain/scenario.js";

/**
 * Loads the frozen suite and reports the hash it was loaded under. The hash is
 * computed by the implementation over the canonical serialization, so callers
 * cannot report a suite identity the loader did not actually see.
 */
export interface ScenarioSuitePort {
  loadSuite(): Promise<{ readonly suite: ScenarioSuite; readonly suiteHash: string }>;
}
