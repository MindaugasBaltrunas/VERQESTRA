import { LocalControlError } from "./local-control-errors.js";

/**
 * What the local integration flow is allowed to ask Git to do.
 *
 * `local-control-contract.md` states the gateway "never force-pushes, resets the
 * target or auto-resolves conflicts". An allowlist is the only way to hold that
 * line: a denylist would have to anticipate every spelling of a destructive
 * command, while this file names the handful of plumbing reads the preview needs
 * and the two exact vectors an integration may run.
 *
 * A violation is `internal_error`, not `invalid_request`. No client can reach
 * this function with its own argument vector — the service builds every one of
 * them — so a rejection here means gateway code tried to do something the
 * contract forbids, which is a fault of the host, not of the caller.
 */

export type LocalGitMode = "read" | "integrate";

/** Read-only plumbing the preview needs to describe an integration. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  "rev-parse",
  "symbolic-ref",
  "status",
  "diff",
  "merge-base",
  "rev-list",
  "cat-file",
  "worktree",
]);

/**
 * Commands that move refs, discard work or rewrite history. They are refused in
 * both modes, so a future caller cannot reach them by asking for `integrate`.
 */
const FORBIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  "push",
  "reset",
  "clean",
  "checkout",
  "switch",
  "rebase",
  "cherry-pick",
  "branch",
  "update-ref",
  "gc",
  "filter-branch",
]);

/** Any flag that turns a refusal by Git into an overwrite. */
const OVERRIDE_FLAG = /^(?:-f|--force(?:-[\w-]+)?|--hard)$/;

/** The only worktree subcommand that reads instead of removing. */
const WORKTREE_READ_SUBCOMMAND = "list";

const MERGE_OID = /^[0-9a-f]{40}$/;

function refuse(detail: string): never {
  throw new LocalControlError("internal_error", `Refused local Git argument vector: ${detail}`);
}

/**
 * NUKRYPIMAS nuo etalono (formos, ne elgesio): pozicijos imamos per destrukturizaciją, o ne
 * `args[n]` po `length` patikros. `noUncheckedIndexedAccess` `length` patikros į elemento tipą
 * neperkelia, tad `MERGE_OID.test(args[3])` etalono forma nekompiliuotųsi. Priimami ir atmetami
 * vektoriai lieka tiksliai tie patys.
 */
function isIntegrationVector(args: readonly string[]): boolean {
  const [command, first, second, third] = args;
  if (command !== "merge") {
    return false;
  }
  if (args.length === 2 && first === "--abort") {
    return true;
  }
  return (
    args.length === 4 &&
    first === "--no-ff" &&
    second === "--no-edit" &&
    third !== undefined &&
    MERGE_OID.test(third)
  );
}

export function assertLocalGitArgv(args: readonly string[], mode: LocalGitMode): void {
  const command = args[0];
  // Tuščias vektorius atpažįstamas per patį elementą, o ne per `length`: taip ta pati patikra
  // vienu metu yra ir tipo susiaurinimas, ir etalono „an empty argument vector" atsisakymas.
  if (command === undefined) {
    refuse("an empty argument vector");
  }
  for (const argument of args) {
    if (OVERRIDE_FLAG.test(argument)) {
      refuse(`${command} carries the override flag ${argument}`);
    }
  }
  if (FORBIDDEN_COMMANDS.has(command)) {
    refuse(`${command} may move or discard the target branch`);
  }
  if (command === "worktree" && args[1] !== WORKTREE_READ_SUBCOMMAND) {
    refuse("worktree may only be listed");
  }
  if (READ_COMMANDS.has(command)) {
    return;
  }
  if (mode === "integrate" && isIntegrationVector(args)) {
    return;
  }
  refuse(`${command} is not allowed in ${mode} mode`);
}
