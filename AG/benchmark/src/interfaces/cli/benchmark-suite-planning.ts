// Reading the frozen suite, and turning a request into a plan the run pipeline can execute.
//
// Moved VERBATIM out of `benchmark-cli-composition.ts`, which had grown past 800 lines and had no
// test of its own — and that combination is where two defects had already hidden. Neither piece
// here needs the composition's wiring: the suite loader takes a package root, and the plan
// resolver is pure. Both are therefore testable on their own, which is the point of the split as
// much as the line count is.
//
// Nothing was reworded on the way across. The refusal strings in particular are contract: a
// caller reads them and a test asserts them, so a split that "improved" them would be a behaviour
// change wearing a refactor's clothes.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
  type BenchmarkRunPlan,
  type BenchmarkRunRequest,
  type BenchmarkScenario,
  type ScenarioSuite,
  type SuiteValidationReport,
} from "../../application/benchmark-api.js";
import { MODE_EXECUTION_PROFILES } from "../../application/ports/execution-plan.js";
import {
  FIXTURE_ROOT,
  toSuiteValidationReport,
  validateBenchmarkSuite,
  type ScenarioDocument,
} from "../../application/validate-suite.js";

const SCENARIO_DIRECTORY = "scenarios";
const SUITE_MANIFEST_FILE = "suite.manifest.json";
const SCENARIO_FILE_SUFFIX = ".scenario.json";

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LoadedSuite {
  /** Present only when the suite validated; a refused suite yields no scenarios and no hash. */
  readonly suite: ScenarioSuite | undefined;
  readonly report: SuiteValidationReport;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function refusedSuite(problem: string): LoadedSuite {
  return { suite: undefined, report: { suiteHash: "", scenarioCount: 0, problems: [problem] } };
}

/**
 * Reads the authored suite from the package and validates it whole.
 *
 * Fail-closed: an unreadable `scenarios/` directory is reported as a problem
 * rather than as an empty suite, because an empty suite validates against
 * nothing and would let `validate` answer "no problems" for a package with no
 * scenarios in it at all.
 */
export async function loadSuite(packageRoot: string): Promise<LoadedSuite> {
  const scenariosDirectory = path.join(packageRoot, SCENARIO_DIRECTORY);

  let fileNames: readonly string[];
  try {
    const entries = await readdir(scenariosDirectory, { withFileTypes: true });
    fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(SCENARIO_FILE_SUFFIX))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    return refusedSuite(`scenarios: the suite directory could not be read: ${describeThrown(error)}`);
  }

  let manifest: unknown;
  try {
    manifest = await readJson(path.join(scenariosDirectory, SUITE_MANIFEST_FILE));
  } catch (error: unknown) {
    return refusedSuite(`scenarios: ${SUITE_MANIFEST_FILE} could not be read: ${describeThrown(error)}`);
  }

  const documents: ScenarioDocument[] = [];
  for (const name of fileNames) {
    try {
      documents.push({ source: name, value: await readJson(path.join(scenariosDirectory, name)) });
    } catch (error: unknown) {
      return refusedSuite(`scenarios/${name}: could not be read: ${describeThrown(error)}`);
    }
  }

  let availableFixtures: readonly string[];
  try {
    const entries = await readdir(path.join(packageRoot, FIXTURE_ROOT), { withFileTypes: true });
    availableFixtures = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${FIXTURE_ROOT}/${entry.name}`);
  } catch (error: unknown) {
    return refusedSuite(`${FIXTURE_ROOT}: the fixture directory could not be read: ${describeThrown(error)}`);
  }

  const outcome = validateBenchmarkSuite(manifest, documents, { availableFixtures });
  return { suite: outcome.suite, report: toSuiteValidationReport(outcome) };
}

/**
 * Resolves a request against the suite: which scenarios, which modes, how many
 * repetitions, and every reason the run would be refused. Nothing is executed
 * and nothing is written, which is what makes it safe to call before a live run
 * as well as for `--dry-run`.
 */
export function resolvePlan(
  suite: ScenarioSuite,
  suiteHash: string,
  request: BenchmarkRunRequest,
): BenchmarkRunPlan {
  const problems: string[] = [];
  const known = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));

  const requested = request.scenarioIds ?? [];
  let selected: readonly BenchmarkScenario[];
  if (requested.length === 0) {
    selected = suite.scenarios;
  } else {
    const found: BenchmarkScenario[] = [];
    for (const id of requested) {
      const scenario = known.get(id);
      if (scenario === undefined) {
        problems.push(`"${id}" is not a scenario of this suite`);
        continue;
      }
      found.push(scenario);
    }
    selected = found;
  }

  if (request.modes.length === 0) {
    problems.push("no execution mode was selected, so there is nothing to compare");
  }
  for (const mode of request.modes) {
    if (MODE_EXECUTION_PROFILES[mode].reachesNetwork && !request.allowNetworkModels) {
      problems.push(
        `mode "${mode}" reaches a paid model over the network; re-run with --allow-network to permit it`,
      );
    }
  }

  if (
    request.repetitions < MINIMUM_NONDETERMINISTIC_OBSERVATIONS &&
    selected.some((scenario) => !scenario.deterministic)
  ) {
    problems.push(
      `the selection contains nondeterministic scenarios, which BENCH-9 requires to be repeated at least ${MINIMUM_NONDETERMINISTIC_OBSERVATIONS} times; --repetitions is ${request.repetitions}`,
    );
  }

  const scenarioIds = selected.map((scenario) => scenario.id).sort();
  return {
    // A refused plan names no suite: reporting the hash of a suite the run will
    // never execute invites a caller to record it as evidence of a measurement.
    suiteHash: problems.length === 0 ? suiteHash : "",
    scenarioIds,
    modes: request.modes,
    repetitions: request.repetitions,
    allowNetworkModels: request.allowNetworkModels,
    sampleCount: scenarioIds.length * request.modes.length * request.repetitions,
    problems,
  };
}

/**
 * `<date>-<suite digest prefix>`: lowercase kebab-case, which the stored
 * document requires, and readable enough that two baselines taken on one day
 * against different suites are visibly different files.
 */
export function baselineIdFor(createdAt: string, suiteHash: string): string {
  const digest = suiteHash.replace("sha256:", "").slice(0, 12);
  return `${createdAt.slice(0, 10)}-${digest === "" ? "unidentified" : digest}`;
}
