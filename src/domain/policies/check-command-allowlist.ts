// Config-driven check-command allowlist shared by the two command-policy layers:
// bash-command-policy.ts (the Bash tool, shell form) and quality-command-policy.ts
// (the quality-gates spawn form). Pure: no node/FS/process imports, no clock, no mutation.
// The FS-reading callers gather the CheckCommandContext
// (application/policy-governance/quality-policy.ts resolveCheckCommandContext) and pass it in.
// Behaviour etalon: AG_loop policy/check-command-allowlist.ts (1:1, WBR VQ-305).
//
// Two allow paths, both SUBORDINATE to the destructive guard, which always wins:
//   1. configured — a spawn-form check declared in vq/config/quality-policy.json. The target
//      project authors its own verification commands there; a declared command is trusted the
//      same way an npm/pnpm script is, but only after the destructive/shell guards pass.
//   2. template — a built-in safe command shape for a stack that is ACTIVE (detected via the
//      project profile / stack decision, or declared): pytest, go test, cargo test, mvn test,
//      gradle test, make test.
//
// Destructive commands (rm, git reset/clean/checkout/push --force, ...) are blocked even when
// they are configured: the allowlist never overrides the README denylist. Argument validation
// rejects shell-token interpolation and exec-enabling flags on every path.

export type CheckStack =
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java-maven"
  | "java-gradle"
  | "make";

/** A structured spawn-form check command: an executable plus its argument vector (no shell). */
export type SpawnCheckCommand = { cmd: string; args: string[] };

/** What a caller knows about the target project when evaluating a check command. */
export type CheckCommandContext = {
  /** Spawn-form checks declared in vq/config/quality-policy.json (all scopes). */
  configuredSpawnChecks: SpawnCheckCommand[];
  /** Stacks that are active for this project (detected or declared). */
  activeStacks: CheckStack[];
};

export const EMPTY_CHECK_COMMAND_CONTEXT: CheckCommandContext = {
  configuredSpawnChecks: [],
  activeStacks: [],
};

// Shell-metacharacter set. Spawn form runs no shell, but these are rejected defensively on every
// path so a configured/template command can never smuggle interpolation into a downstream shell.
const SHELL_TOKEN = /[;&|`$<>\r\n]/;

// Executables that are never a legal check command, whatever the configuration says. Covers
// file destroyers/overwriters, in-place editors, and process/system controls — a configured
// check must not be able to perform destructive I/O just because it carries no shell token.
const DESTRUCTIVE_EXECUTABLES = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "unlink",
  "shred",
  "srm",
  "remove-item",
  "ri",
  "rd",
  "mv",
  "move",
  "move-item",
  "cp",
  "copy",
  "ln",
  "install",
  "dd",
  "truncate",
  "sd",
  "tee",
  "patch",
  "mkfs",
  "format",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "kill",
  "killall",
  "taskkill",
  "chmod",
  "chown",
]);

// busybox is a multi-call wrapper: `busybox rm ...` runs the destructive applet. Inspect arg[0].
const MULTICALL_WRAPPERS = new Set(["busybox", "toybox"]);

// git subcommands that mutate or destroy the working tree / history — never a check command.
const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set([
  "reset",
  "clean",
  "checkout",
  "restore",
  "switch",
  "rebase",
  "push",
  "commit",
  "merge",
  "branch",
  "tag",
  "rm",
  "stash",
  "gc",
  "prune",
  "filter-branch",
  "update-ref",
]);

// Flags that let a test runner execute an arbitrary external program — blocked even inside an
// active template (e.g. `go test -exec <prog>` runs the compiled test binary via <prog>). The
// `(?:=|$)` tail catches both the spaced (`-exec sh`) and joined (`-exec=sh`) forms.
const EXEC_ENABLING_FLAG_PATTERN = /^--?(?:exec|toolexec|test-command)(?:=|$)/i;

// git global options that consume the FOLLOWING argument as their value; the subcommand scanner
// must skip that value so `git -C <path> reset` is still recognized as a `reset`.
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);

// Generic interpreters/shells that run arbitrary code from their arguments. These are never a
// legal check command even when declared in quality-policy.json — declaring `node build` must not
// launder arbitrary script execution past the guard. Non-executor tools (pytest, ruff, mypy,
// golangci-lint, ...) may still be configured; only these code-executors are excluded.
const CODE_EXECUTOR_EXECUTABLES = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "ts-node",
  "tsx",
  "python",
  "python2",
  "python3",
  "py",
  "ruby",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "osascript",
  "wscript",
  "cscript",
  "env",
  "eval",
  "exec",
  "xargs",
  // Package runners fetch and execute arbitrary published code, so `npx <anything>` is a code
  // executor wearing a package manager's name.
  "npx",
  "pnpx",
  "bunx",
  // Network fetchers: the "download a script, then run it" half of a two-stage payload.
  "curl",
  "wget",
  "certutil",
  "bitsadmin",
  // Cross-environment shells: `wsl <cmd>` re-enters a full shell outside this policy.
  "wsl",
  // Note: real toolchain runners a target project legitimately configures as checks — dotnet,
  // java, gradle, mvn, go, cargo, docker — stay allowed. They are how non-JS stacks declare
  // `dotnet test`/`go test`, and the escalation path they once opened is closed at the source:
  // vq/config/quality-policy.json is protected from agent writes (write-policy hooks, E5).
]);

/** True when the executable is a generic interpreter/shell that runs arbitrary code from args. */
export function isCodeExecutorCommand(cmd: string): boolean {
  return CODE_EXECUTOR_EXECUTABLES.has(baseExecutable(cmd));
}

type SpawnTemplate = { stack: CheckStack; executables: string[]; requiredLead: string[] };

// Built-in safe command shapes, one per common non-JS stack. Each is activated ONLY when its
// stack is in the active set. JavaScript keeps its stricter package-manager path in
// quality-command-policy.ts and is intentionally absent here.
const BUILTIN_SPAWN_TEMPLATES: SpawnTemplate[] = [
  { stack: "python", executables: ["pytest"], requiredLead: [] },
  { stack: "go", executables: ["go"], requiredLead: ["test"] },
  { stack: "rust", executables: ["cargo"], requiredLead: ["test"] },
  { stack: "java-maven", executables: ["mvn", "mvnw"], requiredLead: ["test"] },
  { stack: "java-gradle", executables: ["gradle", "gradlew"], requiredLead: ["test"] },
  { stack: "make", executables: ["make"], requiredLead: ["test"] },
];

// Maps a declared/detected language string to the check stacks it activates.
const LANGUAGE_STACK_MAP: Record<string, CheckStack[]> = {
  javascript: ["javascript"],
  typescript: ["javascript"],
  js: ["javascript"],
  ts: ["javascript"],
  node: ["javascript"],
  nodejs: ["javascript"],
  python: ["python"],
  py: ["python"],
  go: ["go"],
  golang: ["go"],
  rust: ["rust"],
  rs: ["rust"],
  java: ["java-maven", "java-gradle"],
  kotlin: ["java-maven", "java-gradle"],
  make: ["make"],
  c: ["make"],
  "c++": ["make"],
  cpp: ["make"],
};

/**
 * Normalizes an executable token: drops any directory prefix, quotes, a Windows extension, and
 * trailing dots/spaces. Trailing-dot stripping matters on Windows, where `CreateProcess("node.")`
 * launches `node.exe` — so `node.` must normalize to `node`, or it would slip past the
 * code-executor lookup.
 */
export function baseExecutable(cmd: string): string {
  const unquoted = cmd.trim().replace(/^["']|["']$/g, "");
  const withoutDir = unquoted.replace(/^.*[\\/]/, "");
  const withoutTrailing = withoutDir.replace(/[.\s]+$/, "");
  return withoutTrailing
    .replace(/\.(?:exe|cmd|bat|ps1|com)$/i, "")
    .replace(/[.\s]+$/, "")
    .toLowerCase();
}

/** Resolves the check stacks a language activates (empty for unknown/unset languages). */
export function checkStacksForLanguage(language?: string | null): CheckStack[] {
  if (!language) return [];
  return LANGUAGE_STACK_MAP[language.trim().toLowerCase()] ?? [];
}

/**
 * True when a command is destructive and must never run as a check, regardless of configuration.
 * Covers file/process-destroying executables, mutating git subcommands, git force flags, and
 * `--no-preserve-root`. This denylist always takes priority over both allow paths.
 */
export function isDestructiveCheckCommand(cmd: string, args: string[]): boolean {
  const exe = baseExecutable(cmd);
  if (DESTRUCTIVE_EXECUTABLES.has(exe)) return true;
  if (MULTICALL_WRAPPERS.has(exe)) {
    // `busybox rm ...` / `toybox rm ...`: the destructive applet is the first non-flag argument.
    const applet = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (applet && DESTRUCTIVE_EXECUTABLES.has(applet)) return true;
  }
  if (exe === "git") {
    const subcommand = gitSubcommand(args);
    if (subcommand && DESTRUCTIVE_GIT_SUBCOMMANDS.has(subcommand)) return true;
    if (args.some((arg) => /^(?:--force|-f)$/i.test(arg))) return true;
  }
  // In-place edit / delete flags on otherwise read-capable tools.
  if (exe === "sed" && args.some((arg) => /^(?:-i|--in-place)/i.test(arg))) return true;
  if (exe === "find" && args.some((arg) => /^-(?:delete|exec|execdir|fdelete)$/i.test(arg))) return true;
  if (args.some((arg) => /^--no-preserve-root$/i.test(arg))) return true;
  return false;
}

// Resolves the git subcommand, skipping global options and any value they consume, so a leading
// `-C <path>` / `-c <cfg>` cannot hide a destructive subcommand from the guard.
function gitSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("-")) {
      if (GIT_VALUE_FLAGS.has(arg)) index++;
      continue;
    }
    return arg.toLowerCase();
  }
  return undefined;
}

function argsAreSafeCheckArgs(args: string[]): boolean {
  return args.every((arg) => !SHELL_TOKEN.test(arg) && !EXEC_ENABLING_FLAG_PATTERN.test(arg));
}

/** True when (cmd,args) exactly matches a spawn-form check declared in quality-policy.json. */
export function matchesConfiguredSpawnCheck(
  cmd: string,
  args: string[],
  configured: SpawnCheckCommand[],
): boolean {
  const exe = baseExecutable(cmd);
  return configured.some(
    (check) =>
      baseExecutable(check.cmd) === exe &&
      check.args.length === args.length &&
      check.args.every((arg, index) => arg === args[index]),
  );
}

/** True when (cmd,args) matches a built-in template whose stack is currently active. */
export function matchesActiveSpawnTemplate(
  cmd: string,
  args: string[],
  activeStacks: CheckStack[],
): boolean {
  const exe = baseExecutable(cmd);
  const active = new Set(activeStacks);
  for (const template of BUILTIN_SPAWN_TEMPLATES) {
    if (!active.has(template.stack)) continue;
    if (!template.executables.includes(exe)) continue;
    if (args.length < template.requiredLead.length) continue;
    const leadMatches = template.requiredLead.every(
      (token, index) => args[index]?.toLowerCase() === token,
    );
    if (!leadMatches) continue;
    if (argsAreSafeCheckArgs(args.slice(template.requiredLead.length))) return true;
  }
  return false;
}

export type CheckCommandResult = { blockedPattern?: string };

/**
 * Evaluates a spawn-form check command against the destructive guard and the two allow paths.
 * Order is load-bearing: shell-token and destructive checks run BEFORE any allow path, so a
 * configured destructive command is still blocked.
 */
export function evaluateSpawnCheckCommand(
  cmd: string,
  args: string[],
  ctx: CheckCommandContext,
): CheckCommandResult {
  if (args.some((arg) => SHELL_TOKEN.test(arg))) {
    return { blockedPattern: "spawn argument contains shell syntax" };
  }
  if (isDestructiveCheckCommand(cmd, args)) {
    return { blockedPattern: `destructive check command: ${cmd}` };
  }
  // Configured commands are trusted only when the executable is not a generic code executor and
  // no argument carries an exec-enabling flag — so the "exec flags are always blocked" contract
  // holds on the configured path too, not just the template path.
  if (
    !isCodeExecutorCommand(cmd) &&
    argsAreSafeCheckArgs(args) &&
    matchesConfiguredSpawnCheck(cmd, args, ctx.configuredSpawnChecks)
  ) {
    return {};
  }
  if (matchesActiveSpawnTemplate(cmd, args, ctx.activeStacks)) return {};
  return { blockedPattern: `spawn executable: ${cmd}` };
}

// Splits a normalized shell segment into an executable and argument tokens, honoring simple
// single/double quotes (so `pytest -k "a or b"` yields the "a or b" arg intact). The upstream
// bash-policy escape guard already rejected $()/backtick/redirection before this runs.
function tokenizeSegment(segment: string): { cmd: string; args: string[] } {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const cleaned = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
  const [cmd = "", ...args] = cleaned;
  return { cmd, args };
}

/**
 * True when a single (already shell-escape-validated) bash segment is an allowed check command.
 * Delegates to {@link evaluateSpawnCheckCommand} on the tokenized segment so the shell and spawn
 * layers share one pipeline (destructive guard, executor exclusion, exec-flag and configured/
 * template rules) and can never diverge. Used by bash-command-policy.ts as an additional allow path.
 */
export function isAllowedCheckSegment(segment: string, ctx: CheckCommandContext): boolean {
  const { cmd, args } = tokenizeSegment(segment);
  if (!cmd) return false;
  return evaluateSpawnCheckCommand(cmd, args, ctx).blockedPattern === undefined;
}
