import type { AgentProvider } from "../../domain/terminal-session.js";

/**
 * Host-side detection of the Claude Code and Codex command line interfaces.
 *
 * `spec.md` requires the host to detect availability, authentication state and
 * version of each provider separately, and `design.md` §14 forbids returning any
 * long-lived credential to the phone. Both properties are structural here rather
 * than conventional:
 *
 * - **No command surface.** The port takes a {@link AgentProvider} and nothing
 *   else. There is no parameter through which a client — or a voice transcript
 *   turned into text — could influence the executable, its arguments or a shell.
 * - **No credential material.** The results below carry a boolean, a normalized
 *   version string and a machine-readable reason code. The adapter observes
 *   credentials only as presence facts; it never reads, forwards or logs their
 *   contents, and raw CLI output never leaves the adapter.
 *
 * Detection is split in two so that one provider's broken installation cannot
 * mask the other's, and so that a version probe (cheap, always meaningful)
 * is not coupled to an authentication probe (provider specific).
 */

/** Host executable presence, plus its version when the CLI reports a parseable one. */
export type AgentProviderInstallation = Readonly<{
  present: boolean;
  /**
   * Normalized `major.minor.patch[-prerelease]` string.
   *
   * Absent whenever the CLI printed something that is not a version number: the
   * adapter forwards a recognised version or nothing at all, so unparsed CLI
   * output — which may contain host paths — cannot reach a client.
   */
  version?: string;
}>;

/**
 * Sign-in state as observed on the host.
 *
 * `unknown` is a real outcome, not a failure: a provider CLI may offer no
 * non-interactive way to ask, in which case the host refuses to guess.
 */
export type AgentProviderAuthentication = "authenticated" | "unauthenticated" | "unknown";

export type AgentProviderAuthenticationResult = Readonly<{
  state: AgentProviderAuthentication;
  /** Machine-readable cause, never a message produced by the provider CLI. */
  reasonCode?: string;
}>;

export interface AgentProviderProbePort {
  /** Host-fixed executable lookup and version read. Never spawns a shell. */
  detectInstallation(provider: AgentProvider): Promise<AgentProviderInstallation>;
  /** Sign-in state only; no credential value is read, returned or logged. */
  detectAuthentication(provider: AgentProvider): Promise<AgentProviderAuthenticationResult>;
}
