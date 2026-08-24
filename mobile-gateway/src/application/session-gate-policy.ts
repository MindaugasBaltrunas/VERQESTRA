import path from "node:path";
import type { GateCommandOutcome } from "./ports/gate-command-runner-port.js";

/**
 * What a quality gate is allowed to be, and what its outcome means.
 *
 * `design.md` §7 names five gates that must pass before local integration, so
 * the set is a constant here rather than host configuration: a host that could
 * shrink the list could also make an unchecked branch look integrable, and the
 * operator would see a green result they never asked for. What the host DOES
 * configure is how each gate is run — the command, its arguments and its time
 * budget — and every one of those is validated before a process exists.
 *
 * The rules below are refusals rather than repairs. A command this file cannot
 * vouch for is a command the gateway must not run at all, because "ran the
 * wrong program" and "ran no program" produce the same green evidence.
 */

/** The five gates `design.md` §7 requires; run order is this order. */
export const REQUIRED_GATE_NAMES = Object.freeze([
  "readme",
  "architecture",
  "secret",
  "typecheck",
  "test",
] as const);

export type RequiredGateName = (typeof REQUIRED_GATE_NAMES)[number];

export type GateCommand = Readonly<{
  name: string;
  executable: string;
  args: readonly string[];
  timeoutMs: number;
}>;

export type GateCommandCatalogue = readonly GateCommand[];

export type GateStatus = "passed" | "failed" | "timed_out" | "errored";

const MAX_EXECUTABLE_LENGTH = 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4096;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;

/** Characters that would split one argument into two, or truncate a path. */
const UNUSABLE_CHARACTER = /[\0\r\n]/;

/**
 * Extensions Windows cannot start without a command interpreter. The package
 * forbids opening a shell, so a batch file is not a program this gateway can
 * launch — refusing it is honest, and quietly opening a shell for it would turn
 * every argument into an execution surface.
 */
const INTERPRETED_EXTENSIONS: ReadonlySet<string> = new Set([".bat", ".cmd"]);

function refuse(detail: string): never {
  throw new Error(`Quality gate command is invalid: ${detail}`);
}

function hasParentSegment(candidate: string): boolean {
  return candidate.split(/[/\\]/).includes("..");
}

export function assertGateCommand(command: GateCommand): void {
  if (!(REQUIRED_GATE_NAMES as readonly string[]).includes(command.name)) {
    refuse(`${command.name} is not one of the required gates`);
  }
  const executable = command.executable;
  // An absolute path is required because a bare name is resolved by the
  // operating system, and on Windows `CreateProcess` may search the current
  // directory first — which here is the worktree the agent just wrote to. A
  // session could otherwise drop a file next to its work and have the host run
  // it as the operator.
  if (!path.isAbsolute(executable)) {
    refuse(`${command.name} names a non-absolute executable`);
  }
  if (executable.length === 0 || executable.length > MAX_EXECUTABLE_LENGTH) {
    refuse(`${command.name} names an executable path of an unusable length`);
  }
  if (UNUSABLE_CHARACTER.test(executable)) {
    refuse(`${command.name} names an executable containing a control character`);
  }
  // Spaces are fine — installation directories have them — but a traversal
  // segment means the configured path is not the path it appears to be.
  if (hasParentSegment(executable)) {
    refuse(`${command.name} names an executable path with a traversal segment`);
  }
  if (INTERPRETED_EXTENSIONS.has(path.extname(executable).toLowerCase())) {
    refuse(`${command.name} names an executable that only a shell could start`);
  }
  if (command.args.length > MAX_ARGUMENTS) {
    refuse(`${command.name} carries too many arguments`);
  }
  for (const argument of command.args) {
    if (argument.length > MAX_ARGUMENT_LENGTH) {
      refuse(`${command.name} carries an argument of an unusable length`);
    }
    // `..` is left alone here: a relative path into the repository is a normal
    // argument for a build tool, and the child's working directory is already
    // pinned to the worktree by the caller.
    if (UNUSABLE_CHARACTER.test(argument)) {
      refuse(`${command.name} carries an argument containing a control character`);
    }
  }
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < MIN_TIMEOUT_MS ||
    command.timeoutMs > MAX_TIMEOUT_MS
  ) {
    refuse(`${command.name} has a time budget outside the supported range`);
  }
}

/**
 * The catalogue must describe every required gate exactly once. A missing entry
 * would leave a gate unrun while the record still claimed a complete run, and a
 * duplicate entry would make "which command produced this result" unanswerable.
 */
export function assertGateCommandCatalogue(catalogue: GateCommandCatalogue): void {
  if (catalogue.length !== REQUIRED_GATE_NAMES.length) {
    refuse(`the catalogue describes ${catalogue.length} of ${REQUIRED_GATE_NAMES.length} required gates`);
  }
  const named = new Set<string>();
  for (const command of catalogue) {
    assertGateCommand(command);
    if (named.has(command.name)) {
      refuse(`${command.name} is described twice`);
    }
    named.add(command.name);
  }
  for (const name of REQUIRED_GATE_NAMES) {
    if (!named.has(name)) {
      refuse(`the catalogue describes no ${name} gate`);
    }
  }
}

/**
 * What one outcome means. Only a process that started, finished on its own and
 * exited zero passed; every other shape is a distinct kind of "not proven", and
 * they are kept apart so an operator can tell a red test from a host that could
 * not run one.
 */
export function gateStatusOf(outcome: GateCommandOutcome): GateStatus {
  if (outcome.startFailed) return "errored";
  if (outcome.timedOut) return "timed_out";
  if (outcome.exitCode === 0) return "passed";
  if (typeof outcome.exitCode === "number") return "failed";
  return "errored";
}

/**
 * The catalogue in required order. Host configuration order is irrelevant to
 * the result, so it must not be able to change which gate an operator sees
 * first — or which one a run stops at when a host later adds an early exit.
 */
export function orderedGateCommands(catalogue: GateCommandCatalogue): readonly GateCommand[] {
  const byName = new Map(catalogue.map((command) => [command.name, command]));
  const ordered: GateCommand[] = [];
  for (const name of REQUIRED_GATE_NAMES) {
    const command = byName.get(name);
    if (command !== undefined) ordered.push(command);
  }
  return Object.freeze(ordered);
}
