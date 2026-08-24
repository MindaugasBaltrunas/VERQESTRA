import type { AgentProvider } from "../domain/terminal-session.js";
import type {
  AgentProviderInstallation,
  AgentProviderProbePort,
  AgentProviderAuthenticationResult,
} from "./ports/agent-provider-probe-port.js";

/**
 * Derives the single provider status the mobile client is allowed to see.
 *
 * `design.md` §8 defines one status model for both providers so the protocol
 * does not change per provider, and the risk table requires that "Claude
 * adapterio klaida sustabdo Codex" cannot happen. Both are enforced here: each
 * provider is probed independently, and a thrown probe becomes that provider's
 * `error` status instead of failing the whole listing.
 *
 * The service is the only place that turns host facts into an availability
 * value, which keeps the fail-closed rule in one testable function: `ready` is
 * reported only on positive evidence of a sign-in. A provider that is installed
 * but whose authentication state cannot be established is reported as
 * `authentication_required`, because that is the state the operator can act on
 * from the host.
 */

export const AGENT_PROVIDERS: readonly AgentProvider[] = Object.freeze([
  "claude-code",
  "codex",
] as const);

export type AgentProviderAvailability =
  | "unavailable"
  | "authentication_required"
  | "ready"
  | "busy"
  | "error";

export type AgentProviderStatus = Readonly<{
  provider: AgentProvider;
  availability: AgentProviderAvailability;
  /** Normalized CLI version, when the host could read one. */
  version?: string;
  /** Set only while this provider owns a live gateway session. */
  activeSessionId?: string;
  /** Machine-readable cause; never provider CLI output. */
  reasonCode?: string;
}>;

/** Live gateway sessions, as reported by the terminal supervisor. */
export type ActiveAgentSession = Readonly<{
  provider: AgentProvider;
  sessionId: string;
}>;

export type AgentProviderStatusDependencies = Readonly<{
  probe: AgentProviderProbePort;
  /**
   * Sessions currently owned by the gateway. Supplied as a lookup rather than a
   * supervisor reference so that provider status stays readable without the
   * terminal runtime, and so a status read can never mutate session state.
   */
  activeSessions?: () => readonly ActiveAgentSession[];
  clock?: () => Date;
  /**
   * How long host probe facts stay reusable. Probing spawns processes, and the
   * Connections screen polls; without a short cache every poll would start two
   * CLI processes per client.
   */
  cacheTtlMs?: number;
}>;

type ProviderFacts =
  | Readonly<{
    outcome: "probed";
    installation: AgentProviderInstallation;
    authentication?: AgentProviderAuthenticationResult;
  }>
  | Readonly<{ outcome: "failed" }>;

type CacheEntry = Readonly<{ facts: ProviderFacts; expiresAtMs: number }>;

const DEFAULT_CACHE_TTL_MS = 15_000;

/**
 * A failed probe is cached far more briefly than a successful one: a transient
 * host fault must not stick to the Connections screen for the full window, while
 * a persistent one still must not start a process per request.
 */
const FAILED_PROBE_CACHE_TTL_MS = 3_000;

/** Optional fields are omitted rather than set to `undefined`, so the object equals its JSON form. */
function busyStatus(
  provider: AgentProvider,
  activeSessionId: string,
  version?: string,
): AgentProviderStatus {
  return Object.freeze({
    provider,
    availability: "busy" as const,
    ...(version === undefined ? {} : { version }),
    activeSessionId,
  });
}

/** Host fault, reduced to a code: a CLI or lookup failure can name paths or accounts. */
function failedStatus(provider: AgentProvider): AgentProviderStatus {
  return Object.freeze({ provider, availability: "error" as const, reasonCode: "probe_failed" });
}

function deriveStatus(provider: AgentProvider, facts: ProviderFacts): AgentProviderStatus {
  if (facts.outcome === "failed") return failedStatus(provider);
  const { installation } = facts;
  if (!installation.present) {
    return Object.freeze({
      provider,
      availability: "unavailable" as const,
      reasonCode: "not_installed",
    });
  }
  const version = installation.version === undefined ? {} : { version: installation.version };
  const authentication = facts.authentication;
  if (authentication?.state === "authenticated") {
    return Object.freeze({ provider, availability: "ready" as const, ...version });
  }
  return Object.freeze({
    provider,
    availability: "authentication_required" as const,
    ...version,
    reasonCode: authentication?.reasonCode
      ?? (authentication?.state === "unauthenticated" ? "not_authenticated" : "auth_state_unknown"),
  });
}

export class AgentProviderStatusService {
  private readonly probe: AgentProviderProbePort;
  private readonly activeSessions: () => readonly ActiveAgentSession[];
  private readonly clock: () => Date;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<AgentProvider, CacheEntry>();
  private readonly inFlight = new Map<AgentProvider, Promise<ProviderFacts>>();
  /** Bumped by refresh(); a probe started under an older generation must not write back. */
  private generation = 0;

  constructor(dependencies: AgentProviderStatusDependencies) {
    this.probe = dependencies.probe;
    this.activeSessions = dependencies.activeSessions ?? (() => []);
    this.clock = dependencies.clock ?? (() => new Date());
    this.cacheTtlMs = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new Error("Agent provider probe cache TTL is invalid");
    }
  }

  /** Status of every known provider; one provider's failure never hides another. */
  async statuses(): Promise<readonly AgentProviderStatus[]> {
    return Promise.all(AGENT_PROVIDERS.map((provider) => this.status(provider)));
  }

  async status(provider: AgentProvider): Promise<AgentProviderStatus> {
    let activeSessionId: string | undefined;
    try {
      activeSessionId = this.activeSessionId(provider);
    } catch {
      // The session lookup belongs to the host, so its failure is this
      // provider's failure — not an exception that hides the other provider.
      return failedStatus(provider);
    }
    // A busy provider needs no host probe: the session itself is the evidence,
    // and probing while the CLI is running buys nothing.
    if (activeSessionId !== undefined) {
      const cached = this.cached(provider);
      return busyStatus(
        provider,
        activeSessionId,
        cached?.outcome === "probed" ? cached.installation.version : undefined,
      );
    }
    return deriveStatus(provider, await this.facts(provider));
  }

  /**
   * Drops cached host facts, e.g. after the operator authenticated on the host.
   *
   * A probe already in flight was started before the host changed, so the
   * generation bump makes its result unusable rather than letting it write the
   * pre-refresh answer back into the cache.
   */
  refresh(provider?: AgentProvider): void {
    this.generation += 1;
    if (provider === undefined) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    this.cache.delete(provider);
    this.inFlight.delete(provider);
  }

  private activeSessionId(provider: AgentProvider): string | undefined {
    return this.activeSessions().find((session) => session.provider === provider)?.sessionId;
  }

  private cached(provider: AgentProvider): ProviderFacts | undefined {
    const entry = this.cache.get(provider);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock().getTime()) {
      this.cache.delete(provider);
      return undefined;
    }
    return entry.facts;
  }

  private async facts(provider: AgentProvider): Promise<ProviderFacts> {
    const cached = this.cached(provider);
    if (cached) return cached;
    // Concurrent readers of the same provider share one probe; otherwise every
    // reconnecting client would spawn its own pair of CLI processes.
    const pending = this.inFlight.get(provider);
    if (pending) return pending;
    const probing: Promise<ProviderFacts> = this.runProbe(provider).finally(() => {
      // Only retire this probe: a `refresh()` during the run has already
      // replaced the entry, and that successor must survive.
      if (this.inFlight.get(provider) === probing) this.inFlight.delete(provider);
    });
    this.inFlight.set(provider, probing);
    return probing;
  }

  private async runProbe(provider: AgentProvider): Promise<ProviderFacts> {
    const generation = this.generation;
    let facts: ProviderFacts;
    try {
      const installation = await this.probe.detectInstallation(provider);
      facts = installation.present
        ? {
          outcome: "probed",
          installation,
          authentication: await this.probe.detectAuthentication(provider),
        }
        : { outcome: "probed", installation };
    } catch {
      // The reason stays on the host: a provider CLI failure message can name
      // paths or accounts, and the client only needs the machine-readable code.
      facts = { outcome: "failed" };
    }
    // A refresh() during the probe made this result stale: it still answers the
    // caller that started it, but it must not write the pre-refresh host state
    // back into the cache.
    if (generation === this.generation) {
      const ttlMs = facts.outcome === "failed"
        ? Math.min(FAILED_PROBE_CACHE_TTL_MS, this.cacheTtlMs)
        : this.cacheTtlMs;
      this.cache.set(provider, {
        facts: Object.freeze(facts),
        expiresAtMs: this.clock().getTime() + ttlMs,
      });
    }
    return facts;
  }
}
