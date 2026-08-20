// Quality-gates komandų politika — plonas grynas sluoksnis virš bash/check-command taisyklių
// (etalono policy/quality-command-policy.ts, WBR VQ-305). Shell forma eina per pilną bash
// politiką; spawn forma — per JS package-manager taisykles arba configured/template allowlist.
// Etalono `node:path` importas pakeistas grynu absoliutumo testu — domain sluoksnis be node API.
import { evaluateBashCommandPolicy } from "./bash-command-policy.js";
import {
  EMPTY_CHECK_COMMAND_CONTEXT,
  evaluateSpawnCheckCommand,
  isDestructiveCheckCommand,
  type CheckCommandContext,
} from "./check-command-allowlist.js";

export type QualityCommandPolicyResult = { blockedPattern?: string };

const qualityScriptPattern = /^(?:build|test|lint|typecheck)(?::[A-Za-z0-9_.-]+)*$/;
const shellTokenPattern = /[;&|`$<>\r\n]/;
const JS_PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);

export function evaluateShellQualityCommand(
  command: string,
  ctx: CheckCommandContext = EMPTY_CHECK_COMMAND_CONTEXT,
): QualityCommandPolicyResult {
  return evaluateBashCommandPolicy(command, ctx);
}

export function evaluateSpawnQualityCommand(
  cmd: string,
  args: string[],
  ctx: CheckCommandContext = EMPTY_CHECK_COMMAND_CONTEXT,
): QualityCommandPolicyResult {
  if (args.some((arg) => shellTokenPattern.test(arg))) {
    return { blockedPattern: "spawn argument contains shell syntax" };
  }
  // Destructive commands are blocked even when configured — the allowlist never overrides the
  // denylist. Checked before the JS package-manager path so `git reset` etc. can never slip through.
  if (isDestructiveCheckCommand(cmd, args)) {
    return { blockedPattern: `destructive check command: ${cmd}` };
  }

  // JavaScript package managers keep their stricter, historical validation: allowed directory
  // flags plus a single build/test/lint/typecheck script, no `--` argument passthrough.
  if (JS_PACKAGE_MANAGERS.has(cmd.trim().toLowerCase())) {
    return evaluateJsPackageManagerCommand(cmd.trim().toLowerCase(), args);
  }

  // Every other executable must be configured in quality-policy.json or match a built-in
  // template whose stack is active. This is what makes non-JS stacks runnable.
  return evaluateSpawnCheckCommand(cmd, args, ctx);
}

function evaluateJsPackageManagerCommand(executable: string, args: string[]): QualityCommandPolicyResult {
  const remaining = args.slice();
  const directoryFlag = executable === "pnpm" ? ["--dir", "-C"] : executable === "npm" ? ["--prefix"] : ["--cwd"];
  if (directoryFlag.includes(remaining[0] ?? "")) {
    const directory = remaining[1];
    if (!directory || !isSafeRelativeDirectory(directory)) {
      return { blockedPattern: `spawn working directory: ${directory ?? "missing"}` };
    }
    remaining.splice(0, 2);
  }

  if (remaining[0] === "run") remaining.shift();
  if (remaining.length !== 1 || !qualityScriptPattern.test(remaining[0] ?? "")) {
    return { blockedPattern: `spawn arguments: ${args.join(" ")}` };
  }
  return {};
}

/** Grynas absoliutumo testas: POSIX `/…`, UNC `\\…` ir Windows drive `C:\…` formos atmestos. */
function isSafeRelativeDirectory(value: string): boolean {
  if (/^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.replace(/\\/g, "/").split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
