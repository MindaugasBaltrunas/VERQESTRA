import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProviderAuthenticationResult,
  AgentProviderInstallation,
  AgentProviderProbePort,
} from "../application/ports/agent-provider-probe-port.js";
import type { AgentProvider } from "../domain/terminal-session.js";
import {
  assertDirectAgentExecutable,
  resolveDirectAgentExecutable,
  DEFAULT_DIRECT_AGENT_EXECUTABLES,
  type DirectAgentExecutableConfig,
  type DirectAgentExecutableResolver,
} from "./node-pty-direct-agent-terminal-adapter.js";

/**
 * Host detection of the Claude Code and Codex command line interfaces.
 *
 * Three properties are deliberate and are asserted by the contract tests:
 *
 * - **Presence is a filesystem fact, not a process.** The executable is located
 *   through the same resolver the PTY adapter uses, so "installed" means the
 *   file the gateway would launch actually exists — no process runs to find out.
 * - **No shell, ever.** The version and sign-in checks run the resolved absolute
 *   path through `execFile` with host-fixed arguments. Nothing a client can send
 *   reaches an argument list, so an untrusted phrase has nowhere to become a
 *   command.
 * - **Credentials are observed, never read.** A credential file is checked for
 *   existence and a credential environment variable for non-emptiness. Contents
 *   are not opened, not parsed, not logged and not returned; raw CLI output is
 *   reduced to a version number or discarded inside this adapter.
 */

/** Result of one host command. `exitCode` is absent when the process never ran. */
export type AgentProviderCommandResult = Readonly<{
  exitCode?: number;
  /** Combined stdout/stderr. Consumed here only; never forwarded to a client. */
  output: string;
}>;

export type AgentProviderCommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<AgentProviderCommandResult>;

/** Existence check for a single absolute path. */
export type HostPathProbe = (absolutePath: string) => Promise<boolean>;

/**
 * How one provider's CLI is interrogated. Every field is host configuration:
 * the gateway never accepts any of it from a remote client.
 */
export type AgentProviderCliProfile = Readonly<{
  /** Arguments that make the CLI print its version. */
  versionArgs: readonly string[];
  /** Non-interactive sign-in check, when the CLI offers one. Exit code 0 means signed in. */
  statusArgs?: readonly string[];
  /** Variables whose presence means credentials are configured. Values are never read. */
  credentialEnvNames?: readonly string[];
  /** Home-relative credential paths. Existence only; contents stay closed. */
  credentialFiles?: readonly string[];
}>;

export type AgentProviderCliProfiles = Readonly<Record<AgentProvider, AgentProviderCliProfile>>;

/**
 * Claude Code exposes no documented non-interactive sign-in query, so its state
 * is derived from configured credential presence. Codex is asked directly and
 * falls back to presence only when the command cannot run.
 */
export const DEFAULT_AGENT_PROVIDER_CLI_PROFILES: AgentProviderCliProfiles = Object.freeze({
  "claude-code": Object.freeze({
    versionArgs: Object.freeze(["--version"]),
    credentialEnvNames: Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
    credentialFiles: Object.freeze([".claude/.credentials.json"]),
  }),
  codex: Object.freeze({
    versionArgs: Object.freeze(["--version"]),
    statusArgs: Object.freeze(["login", "status"]),
    credentialEnvNames: Object.freeze(["OPENAI_API_KEY"]),
    credentialFiles: Object.freeze([".codex/auth.json"]),
  }),
});

const VERSION_TIMEOUT_MS = 10_000;
const AUTH_STATUS_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * A version number and nothing else. CLIs mix their version with install paths
 * and update notices; forwarding only a recognised `major.minor.patch` keeps
 * host detail out of a value that reaches the phone.
 */
const VERSION_PATTERN = /\b(\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][0-9A-Za-z.-]{1,32})?)\b/;

export function parseAgentProviderVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output.slice(0, 512))?.[1];
}

const execFileAsync = promisify(execFile);

async function defaultCommandRunner(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<AgentProviderCommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { exitCode: 0, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    // A numeric `code` is the process' own exit status; anything else (ENOENT,
    // EACCES, EINVAL for a shim Node refuses to launch) or a timeout kill means
    // the answer is "could not run", which is not the same as "failed".
    return typeof failure.code === "number" && !failure.killed
      ? { exitCode: failure.code, output }
      : { output };
  }
}

async function defaultPathProbe(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Home-relative, no traversal: a configured path may never point outside the home directory. */
function resolveCredentialPath(homeDirectory: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Agent provider credential path configuration is invalid");
  }
  const home = resolve(homeDirectory);
  const absolute = resolve(join(home, relativePath));
  if (absolute !== home && !absolute.startsWith(home.endsWith(sep) ? home : `${home}${sep}`)) {
    throw new Error("Agent provider credential path configuration is invalid");
  }
  return absolute;
}

export type HostCliAgentProviderProbeDependencies = Readonly<{
  executables?: DirectAgentExecutableConfig;
  profiles?: AgentProviderCliProfiles;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  resolveExecutable?: DirectAgentExecutableResolver;
  run?: AgentProviderCommandRunner;
  pathExists?: HostPathProbe;
}>;

export class HostCliAgentProviderProbe implements AgentProviderProbePort {
  private readonly executables: DirectAgentExecutableConfig;
  private readonly profiles: AgentProviderCliProfiles;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly resolveExecutable: DirectAgentExecutableResolver;
  private readonly run: AgentProviderCommandRunner;
  private readonly pathExists: HostPathProbe;

  constructor(dependencies: HostCliAgentProviderProbeDependencies = {}) {
    this.executables = dependencies.executables ?? DEFAULT_DIRECT_AGENT_EXECUTABLES;
    this.profiles = dependencies.profiles ?? DEFAULT_AGENT_PROVIDER_CLI_PROFILES;
    this.environment = dependencies.environment ?? process.env;
    this.homeDirectory = dependencies.homeDirectory ?? homedir();
    this.resolveExecutable = dependencies.resolveExecutable ?? resolveDirectAgentExecutable;
    this.run = dependencies.run ?? defaultCommandRunner;
    this.pathExists = dependencies.pathExists ?? defaultPathProbe;
    assertDirectAgentExecutable(this.executables["claude-code"]);
    assertDirectAgentExecutable(this.executables.codex);
    for (const profile of Object.values(this.profiles)) {
      assertFixedArguments(profile.versionArgs);
      if (profile.statusArgs) assertFixedArguments(profile.statusArgs);
      for (const file of profile.credentialFiles ?? []) {
        resolveCredentialPath(this.homeDirectory, file);
      }
    }
  }

  async detectInstallation(provider: AgentProvider): Promise<AgentProviderInstallation> {
    const executable = await this.locate(provider);
    if (executable === undefined) return Object.freeze({ present: false });
    const profile = this.profiles[provider];
    const result = await this.run(executable, profile.versionArgs, VERSION_TIMEOUT_MS);
    // The file exists, so the provider is installed even when its version cannot
    // be read — a launcher shim Node declines to execute must not be reported as
    // a missing installation.
    const version = result.exitCode === 0 ? parseAgentProviderVersion(result.output) : undefined;
    return Object.freeze(version === undefined ? { present: true } : { present: true, version });
  }

  async detectAuthentication(provider: AgentProvider): Promise<AgentProviderAuthenticationResult> {
    const profile = this.profiles[provider];
    if (profile.statusArgs) {
      const executable = await this.locate(provider);
      if (executable !== undefined) {
        const result = await this.run(executable, profile.statusArgs, AUTH_STATUS_TIMEOUT_MS);
        if (result.exitCode === 0) return Object.freeze({ state: "authenticated" as const });
        if (result.exitCode !== undefined) {
          return Object.freeze({
            state: "unauthenticated" as const,
            reasonCode: "cli_reports_signed_out",
          });
        }
      }
      // The check could not run; configured credential presence is the fallback.
    }
    const sources = (profile.credentialEnvNames?.length ?? 0) + (profile.credentialFiles?.length ?? 0);
    if (sources === 0) {
      return Object.freeze({ state: "unknown" as const, reasonCode: "no_host_check_available" });
    }
    return Object.freeze(
      await this.hasCredentialEvidence(profile)
        ? { state: "authenticated" as const }
        : { state: "unauthenticated" as const, reasonCode: "no_host_credential" },
    );
  }

  /** Absolute path of the configured executable, or `undefined` when absent. */
  private async locate(provider: AgentProvider): Promise<string | undefined> {
    let resolved: string;
    try {
      resolved = await this.resolveExecutable(this.executables[provider], this.environment);
    } catch {
      return undefined;
    }
    // The same guard the PTY adapter applies before spawning: a relative result
    // would be resolved against the gateway's working directory instead of the
    // host's `PATH`, which is a different program than the one probed.
    if (!isAbsolute(resolved)) {
      throw new Error("Resolved agent provider executable must be absolute");
    }
    return resolved;
  }

  private async hasCredentialEvidence(profile: AgentProviderCliProfile): Promise<boolean> {
    for (const name of profile.credentialEnvNames ?? []) {
      // Presence and non-emptiness only. The value is never read out of this
      // expression, so it cannot be logged or returned by accident.
      if ((this.environment[name] ?? "").length > 0) return true;
    }
    for (const file of profile.credentialFiles ?? []) {
      if (await this.pathExists(resolveCredentialPath(this.homeDirectory, file))) return true;
    }
    return false;
  }
}

/**
 * Host-fixed arguments must be plain literals. Nothing here comes from a client,
 * and this keeps it that way even if a future host config file is mis-edited.
 */
function assertFixedArguments(args: readonly string[]): void {
  if (args.length === 0 || args.length > 8) {
    throw new Error("Agent provider CLI argument configuration is invalid");
  }
  for (const argument of args) {
    if (
      argument.length === 0 ||
      argument.length > 64 ||
      argument.includes("\0") ||
      /[\r\n]/.test(argument)
    ) {
      throw new Error("Agent provider CLI argument configuration is invalid");
    }
  }
}
