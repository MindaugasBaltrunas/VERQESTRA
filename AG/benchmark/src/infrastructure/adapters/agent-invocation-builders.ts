import type { NormalizedExecutionPlan } from "../../application/ports/execution-plan.js";
import { EXECUTION_MODES, type ExecutionMode } from "../../domain/result.js";
import type { AgentInvocation } from "./execution-adapter-support.js";

/**
 * The command lines the networked modes are driven by (BENCH-1, BENCH-3).
 *
 * `ProcessExecutionAdapter` deliberately owns no command line: which binary runs
 * a mode, with which flags and with which credentials in its environment, is a
 * deployment fact, and an adapter that guessed it would spend money and then fail
 * for a reason that has nothing to do with the agent. This module is where that
 * deployment fact is written down — as *data* first, and only then turned into
 * the pure `plan -> invocation` functions the adapters take.
 *
 * Two properties are the reason for the indirection.
 *
 * A template is validated once, when the CLI is wired, rather than when a cell
 * runs. A misspelled placeholder or an impossible step limit is a configuration
 * defect, and discovering it half-way through a paid suite costs the tokens
 * already spent as well as the run. So `createAgentInvocations` reads the whole
 * configuration eagerly and refuses it whole.
 *
 * And a built invocation is an argument vector, never a command string. Every
 * placeholder is substituted into one element at a time, in a single pass that
 * never rescans what it just wrote, so nothing a scenario puts in its task text
 * can become a second argument, a redirection, a shell word or a second
 * placeholder — the prompt reaches the agent as one opaque value, which is what
 * makes running an authored scenario against a live model safe to do at all.
 */

/** Tokens a template may carry; substituted from the plan, never from a shell. */
export const AGENT_INVOCATION_PLACEHOLDERS = [
  "scenarioId",
  "model",
  "prompt",
  "timeoutMs",
  "tokenLimit",
  "stepLimit",
  "startCommit",
  "workingDirectory",
] as const;

export type AgentInvocationPlaceholder = (typeof AGENT_INVOCATION_PLACEHOLDERS)[number];

/** One mode's command line, before a plan has been substituted into it. */
export interface AgentInvocationTemplate {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  /** Names of host environment variables forwarded verbatim. Values never appear in this repository. */
  readonly forwardedEnvironment: readonly string[];
  /** Literal environment entries; values may carry placeholders. Applied after the forwarded ones. */
  readonly environment: Readonly<Record<string, string>>;
  /** The agentic step ceiling handed to the agent as `{{stepLimit}}`. */
  readonly stepLimit: number;
}

/** The command lines a deployment declares, one per mode it can drive. */
export type AgentInvocationConfig = Readonly<Partial<Record<ExecutionMode, AgentInvocationTemplate>>>;

/**
 * Raised for a configuration no run can be driven from.
 *
 * Thrown rather than reported, and thrown while wiring rather than while
 * executing: a deployment whose command line cannot be built has not produced a
 * bad measurement, it has produced no measurement at all, and the difference
 * must not be discovered after a paid cell has already run.
 */
export class AgentInvocationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInvocationConfigError";
  }
}

/**
 * One attempt, no retry layer to spend steps on. Part of what a sample was
 * measured under, which is why it lives beside the flag that carries it.
 */
export const AGENT_SOLO_STEP_LIMIT = 40;

/**
 * Credential variables forwarded from the host, by name.
 *
 * Names only: a value belongs to the operator's shell, never to a repository, and
 * forwarding by name is what lets this file be read by anyone without it holding
 * anything worth reading.
 */
export const FORWARDED_CREDENTIAL_VARIABLES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * The marker that tells an `ag loop` it is running as one bounded benchmark cell.
 *
 * Preventive, not corrective. Nothing observed says a driven cell has reached the
 * loop's queue-empty audit: `benchmark-drive.ts` makes exactly one
 * `runClaudeHeadless` call and never calls `handleEmptyQueue`, a benchmark
 * worktree lives under `os.tmpdir()` where the project's hooks do not reach,
 * `vq/logs/orchestrator.log` records no queue-empty audit inside the run window,
 * and that run's `limits.timeoutMs` was 3600000. So this is defense in depth: it
 * makes a cell bounded *before* the day the drive path routes through `ag loop`,
 * rather than after a suite has paid for the unbounded version.
 *
 * The name is deliberately long and product-specific, because the only variable a
 * skipped audit may hinge on is one no shell or CI sets by coincidence.
 */
export const AG_LOOP_BOUNDED_CELL_VARIABLE = "AG_BENCHMARK_BOUNDED_CELL";

/** The single value the marker is set to; the loop's own predicate decides what it means. */
export const AG_LOOP_BOUNDED_CELL_VALUE = "1";

function freezeTemplate(template: AgentInvocationTemplate): AgentInvocationTemplate {
  return Object.freeze({
    ...template,
    args: Object.freeze([...template.args]),
    forwardedEnvironment: Object.freeze([...template.forwardedEnvironment]),
    environment: Object.freeze({ ...template.environment }),
  });
}

/**
 * How this repository drives the networked mode it can drive.
 *
 * `agent-solo` only. `ag-loop` has no entry, because the `ag loop` command this
 * repository ships cannot be driven from an argument vector at all: it takes its
 * work from the project's task queue rather than from a command line, so a
 * scenario handed to it on standard input would reach nothing, and it scaffolds
 * its own state — task queue, logs, UI service — into whatever directory it is
 * pointed at, so the checkout the harness measures would carry the loop's own
 * files in its diff. No argv-only template can both deliver a scenario and leave
 * the measured checkout untouched, and wiring one anyway would spend money on
 * cells that cannot produce a measurement. A deployment whose loop entry point
 * *does* take a task on its command line supplies its own template through
 * {@link AgentInvocationFactoryOptions.config}; the mechanism here builds one for
 * any mode, it is only the shipped default that stays at what this repository can
 * actually measure.
 *
 * `deterministic-control` has no entry and never gets one: it is executed by
 * applying a declared script to the checkout, and a control that could be driven
 * as a process would be another agent rather than the floor the others are
 * measured against.
 *
 * Frozen through, because these are the terms a stored sample was produced under;
 * a run that mutated a template would report numbers whose recorded configuration
 * no longer describes how they were obtained.
 */
export const DEFAULT_AGENT_INVOCATION_CONFIG: AgentInvocationConfig = Object.freeze({
  "agent-solo": freezeTemplate({
    command: "claude",
    args: [
      "--print",
      "--model",
      "{{model}}",
      "--max-turns",
      "{{stepLimit}}",
      "--permission-mode",
      "acceptEdits",
    ],
    stdin: "{{prompt}}",
    forwardedEnvironment: FORWARDED_CREDENTIAL_VARIABLES,
    environment: {},
    stepLimit: AGENT_SOLO_STEP_LIMIT,
  }),
});

/** One mode's built command line: a pure function of the plan it is handed. */
export type AgentInvocationFactory = (plan: NormalizedExecutionPlan) => AgentInvocation;

export interface AgentInvocationFactoryOptions {
  /**
   * The templates to build from; the shipped default when absent.
   *
   * Deployment source, and only that. It chooses which binary runs, with which
   * argument vector, and which host variables — a credential above all — are
   * forwarded into the child, so it must never be populated from scenario data, a
   * configuration file, an environment variable or a command-line argument. Any of
   * those would let something outside the deployment decide what this package
   * executes and what it hands the executed program.
   */
  readonly config?: AgentInvocationConfig;
  /** Host environment, read once at wiring time so each built invocation stays a pure function of its plan. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Every `{{token}}` a string carries, whether or not it names a known placeholder. */
const PLACEHOLDER_REFERENCE = /\{\{([^}]*)\}\}/g;

const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(AGENT_INVOCATION_PLACEHOLDERS);

/** The values one plan substitutes into its mode's template. */
type PlaceholderValues = Readonly<Record<AgentInvocationPlaceholder, string>>;

function refuse(mode: ExecutionMode, problem: string): never {
  throw new AgentInvocationConfigError(
    `The agent invocation configured for the "${mode}" mode ${problem}.`,
  );
}

function checkPlaceholders(mode: ExecutionMode, where: string, text: string): void {
  for (const match of text.matchAll(PLACEHOLDER_REFERENCE)) {
    const token = match[1] ?? "";
    if (KNOWN_PLACEHOLDERS.has(token)) continue;
    refuse(
      mode,
      `carries the unknown placeholder "{{${token}}}" in ${where}; the known placeholders are ${AGENT_INVOCATION_PLACEHOLDERS.join(", ")}`,
    );
  }
}

/**
 * For a field that is used literally rather than substituted.
 *
 * A known token is refused here as firmly as an unknown one: nothing rewrites it,
 * so it would reach the operating system as part of a program name, and the
 * failure an operator would see is an ENOENT for a binary with braces in it.
 */
function checkNoPlaceholders(mode: ExecutionMode, where: string, text: string): void {
  for (const match of text.matchAll(PLACEHOLDER_REFERENCE)) {
    refuse(
      mode,
      `carries the placeholder "{{${match[1] ?? ""}}}" in ${where}, which is used literally and never substituted`,
    );
  }
}

/**
 * A NUL cannot survive the boundary between this process and a child's argument
 * vector, so a value carrying one would be silently truncated rather than passed
 * — a command line that is not the one that was configured.
 */
function checkNoNul(mode: ExecutionMode, where: string, text: string): void {
  if (text.includes("\0")) refuse(mode, `carries a NUL byte in ${where}`);
}

function checkEnvironmentName(mode: ExecutionMode, name: string): void {
  if (name === "") refuse(mode, "names an environment variable with an empty name");
  if (name.includes("=") || name.includes("\0")) {
    refuse(mode, `names the environment variable "${name}", which contains "=" or a NUL byte`);
  }
}

function validateTemplate(mode: ExecutionMode, template: AgentInvocationTemplate): void {
  if (template.command.trim() === "") refuse(mode, "names no command to run");
  checkNoNul(mode, "its command", template.command);
  // A template naming "{{model}}" would otherwise pass wiring and then try to
  // spawn a binary called exactly that, on a cell that has already been paid for.
  checkNoPlaceholders(mode, "its command", template.command);

  template.args.forEach((argument, index) => {
    checkNoNul(mode, `argument ${index}`, argument);
    checkPlaceholders(mode, `argument ${index}`, argument);
  });
  checkNoNul(mode, "its standard input", template.stdin);
  checkPlaceholders(mode, "its standard input", template.stdin);

  for (const name of template.forwardedEnvironment) checkEnvironmentName(mode, name);
  for (const [name, value] of Object.entries(template.environment)) {
    checkEnvironmentName(mode, name);
    checkNoNul(mode, `the environment variable "${name}"`, value);
    checkPlaceholders(mode, `the environment variable "${name}"`, value);
  }

  if (!Number.isSafeInteger(template.stepLimit) || template.stepLimit <= 0) {
    refuse(
      mode,
      `declares a step limit of ${String(template.stepLimit)}, which is not a positive integer`,
    );
  }
}

/**
 * The forwarded credentials, captured once.
 *
 * A variable the host does not set yields no key at all. An empty string would be
 * worse than absent: several CLIs read "set but blank" as a credential the
 * operator supplied, and fail authentication instead of falling back to the
 * session the operator actually has.
 */
function captureForwarded(
  template: AgentInvocationTemplate,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const forwarded: Record<string, string> = {};
  for (const name of template.forwardedEnvironment) {
    const value = environment[name];
    if (value !== undefined && value !== "") forwarded[name] = value;
  }
  return forwarded;
}

/**
 * Whole-string substitution, applied to one element at a time.
 *
 * The element is never split afterwards, so a prompt containing shell syntax, a
 * quote or a newline stays exactly one argument (or exactly the standard input)
 * and can add nothing to the command line the deployment declared.
 *
 * One pass, with a function as the replacement, and both properties are load
 * bearing. A pass per placeholder would rescan what an earlier pass wrote, so a
 * task text mentioning `{{workingDirectory}}` would come out carrying this host's
 * path — the delivered prompt would no longer be the authored one, and it would
 * differ per run. And a string replacement runs the `$&`, `` $` ``, `$'`, `$$`
 * and `$n` expansions, so a prompt containing them would be rewritten too. A
 * validated template has no unknown token left, but an unrecognised one is
 * returned untouched rather than dropped, so a value can never silently vanish.
 */
function substitute(text: string, values: PlaceholderValues): string {
  // A fresh RegExp per call: the module-level one is global and carries
  // `lastIndex` across the `matchAll` calls validation makes.
  return text.replace(new RegExp(PLACEHOLDER_REFERENCE.source, "g"), (whole, token: string) =>
    KNOWN_PLACEHOLDERS.has(token) ? values[token as AgentInvocationPlaceholder] : whole,
  );
}

function buildInvocation(
  mode: ExecutionMode,
  template: AgentInvocationTemplate,
  forwarded: Readonly<Record<string, string>>,
  plan: NormalizedExecutionPlan,
): AgentInvocation {
  if (plan.mode !== mode) {
    // A builder is bound to the mode it was configured for, so this is a wiring
    // defect rather than an agent result: silently driving one mode's plan with
    // another's command line would produce a sample attributed to the wrong mode.
    throw new AgentInvocationConfigError(
      `The "${mode}" agent invocation was handed a plan for the "${plan.mode}" mode.`,
    );
  }

  const values: PlaceholderValues = {
    scenarioId: plan.scenarioId,
    model: plan.model,
    prompt: plan.prompt,
    timeoutMs: String(plan.limits.timeoutMs),
    tokenLimit: String(plan.limits.tokenLimit),
    // From the template: the step ceiling is a property of how the deployment
    // drives the mode, not of the scenario being driven.
    stepLimit: String(template.stepLimit),
    startCommit: plan.startCommit,
    workingDirectory: plan.workingDirectory,
  };

  const env: Record<string, string> = { ...forwarded };
  for (const [name, value] of Object.entries(template.environment)) {
    env[name] = substitute(value, values);
  }

  // The bounded-cell marker, for the `ag-loop` mode only, and written last.
  //
  // Last, because a deployment template declaring the same name would otherwise
  // decide what a bounded cell is — and a guarantee a template could weaken to
  // "0" is not one. Literal, never through `substitute`, for the same reason: the
  // value must not be reachable from plan data. Mode-scoped by the literal
  // "ag-loop" because it is only that mode that runs a queue-driven loop; the
  // other modes are one bounded attempt already.
  if (mode === "ag-loop") env[AG_LOOP_BOUNDED_CELL_VARIABLE] = AG_LOOP_BOUNDED_CELL_VALUE;

  return Object.freeze({
    // The command itself is literal: a binary chosen by a scenario would be an
    // execution the deployment never approved.
    command: template.command,
    args: Object.freeze(template.args.map((argument) => substitute(argument, values))),
    stdin: substitute(template.stdin, values),
    env: Object.freeze(env),
  });
}

/**
 * Builds one pure invocation function per configured mode.
 *
 * Neither a working directory nor a timeout is set here: `ProcessExecutionAdapter`
 * spawns in `plan.workingDirectory` and kills at `plan.limits.timeoutMs`, and a
 * second copy of either would be a second answer to the question of what bounds a
 * run. The `{{timeoutMs}}`, `{{tokenLimit}}` and `{{stepLimit}}` placeholders only
 * *inform* the child of the budget it is being held to; the enforcement stays with
 * the adapter and the runner, where an agent cannot decline it.
 */
export function createAgentInvocations(
  options: AgentInvocationFactoryOptions = {},
): Readonly<Partial<Record<ExecutionMode, AgentInvocationFactory>>> {
  const config = options.config ?? DEFAULT_AGENT_INVOCATION_CONFIG;
  const environment = options.environment ?? process.env;

  for (const key of Object.keys(config)) {
    if (!(EXECUTION_MODES as readonly string[]).includes(key)) {
      throw new AgentInvocationConfigError(
        `"${key}" is not an execution mode (${EXECUTION_MODES.join(", ")}), so no agent invocation can be configured for it.`,
      );
    }
  }
  if (Object.hasOwn(config, "deterministic-control")) {
    throw new AgentInvocationConfigError(
      'The "deterministic-control" mode is never driven as a process: it applies a declared script to the checkout, which is what makes it the floor the other modes are measured against.',
    );
  }

  const builders: Partial<Record<ExecutionMode, AgentInvocationFactory>> = {};
  for (const [key, template] of Object.entries(config)) {
    if (template === undefined) continue;
    const mode = key as ExecutionMode;
    validateTemplate(mode, template);
    const forwarded = captureForwarded(template, environment);
    builders[mode] = (plan) => buildInvocation(mode, template, forwarded, plan);
  }
  return Object.freeze(builders);
}
