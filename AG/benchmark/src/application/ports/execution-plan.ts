import type { ModelSettings } from "../../domain/baseline.js";
import { EXECUTION_MODES, type ExecutionMode } from "../../domain/result.js";
import type { BenchmarkScenario, ScenarioLimits } from "../../domain/scenario.js";

/**
 * The normalized execution plan every mode is driven from (BENCH-3).
 *
 * BENCH-3 asks for one thing that is easy to state and easy to lose: the model,
 * the prompt, the starting commit, the limits and the checks must be equal
 * across modes *where that is technically comparable*, and every remaining
 * difference must appear in the report. The failure mode this module exists to
 * prevent is the second half. Differences are not hard to avoid — they are hard
 * to notice, because each one arrives as a reasonable local decision (a mode
 * that has no model, a prompt an envelope has to carry, a retry layer only one
 * mode owns) and none of them announce themselves in the numbers afterwards.
 *
 * So the plan is computed in one place, from the scenario declaration alone, and
 * every way a mode departs from it is declared up front as data rather than
 * discovered later in prose. An adapter cannot quietly execute something other
 * than the plan without the difference showing up beside its own result.
 */

/** The aspects of a plan a mode can be unable to hold equal. */
export const MODE_DIFFERENCE_ASPECTS = ["model", "prompt", "limits", "telemetry"] as const;

export type ModeDifferenceAspect = (typeof MODE_DIFFERENCE_ASPECTS)[number];

/**
 * One declared departure from the common plan. `code` is stable and
 * machine-readable so a report can group differences across runs; `detail` is
 * the sentence a reader needs to judge whether a comparison still means
 * anything.
 */
export interface ModeDifference {
  readonly aspect: ModeDifferenceAspect;
  readonly code: string;
  readonly detail: string;
}

/**
 * What a mode is, structurally: whether a model is involved at all, whether
 * reaching it needs a network, and what that mode cannot hold equal to the
 * others. Everything an adapter is allowed to assume about its own mode comes
 * from here, so the assumption is reviewable in one list instead of spread
 * across three adapters.
 */
export interface ModeExecutionProfile {
  readonly mode: ExecutionMode;
  readonly usesModel: boolean;
  /**
   * Whether executing this mode reaches a paid model over a network. The
   * benchmark refuses such a mode unless the caller opted in explicitly, so this
   * flag decides a permission rather than describing a preference.
   */
  readonly reachesNetwork: boolean;
  readonly differences: readonly ModeDifference[];
}

/**
 * The model identifier recorded for a mode that calls no model. A literal rather
 * than an empty string: `SampleTelemetry.model` is grouped on in reports, and an
 * empty value there reads as "unknown model" — the opposite of what the control
 * mode establishes.
 */
export const CONTROL_MODEL_ID = "none";

function freezeProfile(profile: ModeExecutionProfile): ModeExecutionProfile {
  return Object.freeze({
    ...profile,
    differences: Object.freeze(profile.differences.map((difference) => Object.freeze(difference))),
  });
}

/**
 * The differences each mode declares before it runs.
 *
 * Frozen through, because these are the terms a stored comparison was made
 * under: a run that mutated a profile at runtime would produce samples whose
 * recorded caveats no longer describe how they were produced.
 */
export const MODE_EXECUTION_PROFILES: Readonly<Record<ExecutionMode, ModeExecutionProfile>> =
  Object.freeze({
    "ag-loop": freezeProfile({
      mode: "ag-loop",
      usesModel: true,
      reachesNetwork: true,
      differences: [
        {
          aspect: "prompt",
          code: "prompt-wrapped-in-task-contract",
          detail:
            "The loop delivers the scenario task text unchanged, but inside its own task-file envelope and alongside its supervisor instructions, so the tokens the model sees are a superset of the prompt.",
        },
        {
          aspect: "telemetry",
          code: "cost-summed-over-attempts",
          detail:
            "One sample can cover several dispatches: tokens, LLM calls, attempts, repairs and human-review events are the sum over everything the loop did for this scenario.",
        },
      ],
    }),
    "agent-solo": freezeProfile({
      mode: "agent-solo",
      usesModel: true,
      reachesNetwork: true,
      differences: [
        {
          aspect: "telemetry",
          code: "single-attempt-by-construction",
          detail:
            "The mode has no retry, repair or review layer to count, so attempts is 1 and repairs and human-review events are 0 — a zero that means absent, not achieved.",
        },
      ],
    }),
    "deterministic-control": freezeProfile({
      mode: "deterministic-control",
      usesModel: false,
      reachesNetwork: false,
      differences: [
        {
          aspect: "model",
          code: "no-model-is-called",
          detail: `No model is involved, so no model setting applies and the recorded model is "${CONTROL_MODEL_ID}".`,
        },
        {
          aspect: "prompt",
          code: "prompt-not-delivered",
          detail:
            "The scenario task text is never sent anywhere; the control reacts only to the scenario declaration, which is what makes it a floor rather than a competitor.",
        },
        {
          aspect: "telemetry",
          code: "zero-token-cost",
          detail:
            "No LLM call is made, so this mode measures what the harness itself costs rather than what solving the scenario costs.",
        },
      ],
    }),
  });

/** The profile of `mode`, refusing a value that is not one of the known modes. */
export function modeExecutionProfile(mode: ExecutionMode): ModeExecutionProfile {
  const profile = MODE_EXECUTION_PROFILES[mode];
  if (profile === undefined) {
    throw new RangeError(
      `"${mode}" is not a known execution mode (${EXECUTION_MODES.join(", ")}), so no execution profile exists for it.`,
    );
  }
  return profile;
}

/** Conditions that apply to every mode of a run, from the suite config (BENCH-8). */
export interface ExecutionPlanSettings {
  readonly modelSettings: ModelSettings;
  /**
   * The run-wide ceiling. A scenario declares its own limits and the effective
   * limit is the smaller of the two, so raising a scenario's ceiling in the
   * suite cannot raise what a run was configured to spend.
   */
  readonly ceiling: ScenarioLimits;
}

/** What a plan is computed from — the scenario declaration plus the checkout it will run in. */
export interface ExecutionPlanInput {
  readonly scenario: BenchmarkScenario;
  readonly mode: ExecutionMode;
  /** Absolute path of the isolated checkout this execution is confined to. */
  readonly workingDirectory: string;
  readonly startCommit: string;
  /** The caller's explicit decision to permit paid, networked execution. */
  readonly allowNetworkModels: boolean;
}

/**
 * The single description of what an adapter is about to do. Everything an
 * adapter needs is here, so an adapter that consults the scenario for anything
 * else is visibly reaching around the normalization.
 */
export interface NormalizedExecutionPlan {
  readonly mode: ExecutionMode;
  readonly scenarioId: string;
  /** The model to use, or {@link CONTROL_MODEL_ID} for a mode that calls none. */
  readonly model: string;
  readonly prompt: string;
  readonly limits: ScenarioLimits;
  readonly workingDirectory: string;
  readonly startCommit: string;
  /**
   * Scenarijaus deklaruota redagavimo riba ir jo patikrų komandos.
   *
   * Reikalingos rezimui, kuris ne tik paleidzia agenta, bet stato jam UZDUOTI: be ribos loop'as
   * dirbtu be scope varto, o be patikru — be kokybes varto, ir abiem atvejais matuotume loop'a
   * su isjungtu sluoksniu, vadindami tai loop'o kaina. Vieno kvietimo rezimams jos inertiskos.
   */
  readonly allowedPaths: readonly string[];
  readonly checkCommands: readonly string[];
  /**
   * Whether this execution may reach a model over the network. False for every
   * mode that does not need one, and false for a mode that does when the caller
   * did not opt in — the two cases are distinguished by the profile, never by
   * this flag alone.
   */
  readonly networkPermitted: boolean;
  readonly differences: readonly ModeDifference[];
}

/**
 * Line endings are normalized and trailing horizontal whitespace is removed.
 *
 * Not cosmetics: the same suite file checked out on Windows and on Linux differs
 * by a carriage return per line, which is a different token count and a
 * different prompt hash for what BENCH-3 requires to be the identical prompt.
 * Normalizing at the one place the prompt is produced makes "the same prompt"
 * true byte for byte rather than true in spirit.
 */
export function normalizePrompt(task: string): string {
  const normalized = task
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (normalized === "") {
    throw new RangeError("The scenario task text is empty, so there is no prompt to execute.");
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer, not ${String(value)}.`);
  }
  return value;
}

/**
 * The effective limits: the smaller of what the scenario declared and what the
 * run allows. Both are validated rather than trusted — an unusable limit reaching
 * an adapter becomes a timeout that never fires or a token budget of zero, and
 * both look like agent behaviour in the results.
 */
export function normalizeLimits(
  scenario: ScenarioLimits,
  ceiling: ScenarioLimits,
): ScenarioLimits {
  return {
    timeoutMs: Math.min(
      positiveInteger(scenario.timeoutMs, "The scenario timeout"),
      positiveInteger(ceiling.timeoutMs, "The run timeout ceiling"),
    ),
    tokenLimit: Math.min(
      positiveInteger(scenario.tokenLimit, "The scenario token limit"),
      positiveInteger(ceiling.tokenLimit, "The run token ceiling"),
    ),
  };
}

/**
 * Builds the plan for one execution. Pure and total: it either returns a plan
 * every mode can be held to, or throws, and it never silently repairs an input
 * that would have made two modes incomparable.
 */
export function normalizeExecutionPlan(
  input: ExecutionPlanInput,
  settings: ExecutionPlanSettings,
): NormalizedExecutionPlan {
  const profile = modeExecutionProfile(input.mode);

  let model = CONTROL_MODEL_ID;
  if (profile.usesModel) {
    model = settings.modelSettings.model.trim();
    if (model === "") {
      throw new RangeError(
        `The "${input.mode}" mode calls a model, but the run configuration names none.`,
      );
    }
  }

  if (input.workingDirectory === "") {
    throw new RangeError(
      `The "${input.mode}" execution has no working directory, so it is not confined to an isolated checkout.`,
    );
  }

  return {
    mode: input.mode,
    scenarioId: input.scenario.id,
    model,
    prompt: normalizePrompt(input.scenario.task),
    limits: normalizeLimits(input.scenario.limits, settings.ceiling),
    workingDirectory: input.workingDirectory,
    startCommit: input.startCommit,
    allowedPaths: [...input.scenario.allowedPaths],
    checkCommands: input.scenario.checks.map((check) => check.command.join(" ")),
    // A mode that needs no network never gets one, however the caller decided.
    networkPermitted: profile.reachesNetwork && input.allowNetworkModels,
    differences: profile.differences,
  };
}
