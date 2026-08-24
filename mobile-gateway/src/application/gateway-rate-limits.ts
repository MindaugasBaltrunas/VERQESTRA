import {
  SlidingWindowRateLimiter,
  type RateLimitDecision,
  type RateLimitPolicy,
} from "../domain/request-rate-limiter.js";

export type { RateLimitDecision, RateLimitPolicy };

/** Budgeted gateway surfaces. */
export type RateLimitedSurface = "pairing" | "refresh" | "terminal-mutation" | "github-read";

const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Pairing redemption budget from `verification-matrix.md`, keyed by source address. */
export const PAIRING_ATTEMPT_POLICY: RateLimitPolicy = Object.freeze({
  limit: 5,
  windowMs: TEN_MINUTES_MS,
  maxTrackedKeys: 4096,
});

/**
 * Refresh is a legitimate recurring call for every paired device (access tokens
 * live 15 minutes), so its budget is looser than pairing while still bounding
 * offline proof-guessing against a stolen refresh token. Keyed by source address.
 */
export const REFRESH_ATTEMPT_POLICY: RateLimitPolicy = Object.freeze({
  limit: 30,
  windowMs: TEN_MINUTES_MS,
  maxTrackedKeys: 4096,
});

/**
 * Terminal mutation budget, keyed by device rather than by source address.
 *
 * Authentication alone is not a DoS control: a stolen or compromised paired
 * device holds a valid access token and can otherwise drive input, resize and
 * signal calls without limit. The window is sized well above interactive use
 * (a human submits lines, not keystrokes, and resize follows orientation
 * changes) so it throttles automation without touching normal operation.
 */
export const TERMINAL_MUTATION_POLICY: RateLimitPolicy = Object.freeze({
  limit: 120,
  windowMs: 60 * 1000,
  maxTrackedKeys: 256,
});

/**
 * GitHub read budget, keyed by device for the same reason as terminal mutation.
 *
 * A GitHub read is not a cheap lookup: the project status route starts four
 * short-lived `git` processes per request and is deliberately not cached,
 * because working-tree divergence changes with every local commit. An
 * authenticated device is therefore a process amplifier, and authentication
 * alone is not a DoS control. The window sits far above a screen that polls
 * every few seconds, so it throttles automation without touching normal use.
 */
export const GITHUB_READ_POLICY: RateLimitPolicy = Object.freeze({
  limit: 60,
  windowMs: 60 * 1000,
  maxTrackedKeys: 256,
});

/**
 * Application-level rate policy for the gateway.
 *
 * The domain owns the sliding-window mechanism; this service owns the decision
 * of WHICH surfaces are budgeted, how much, and what identity keys them — so
 * the HTTP interface layer asks an application collaborator instead of reaching
 * into the domain and carrying the policy constants itself.
 */
export class GatewayRateLimits {
  private readonly limiters: Readonly<Record<RateLimitedSurface, SlidingWindowRateLimiter>>;

  constructor(
    policies: Partial<Record<RateLimitedSurface, RateLimitPolicy>> = {},
  ) {
    this.limiters = {
      pairing: new SlidingWindowRateLimiter(policies.pairing ?? PAIRING_ATTEMPT_POLICY),
      refresh: new SlidingWindowRateLimiter(policies.refresh ?? REFRESH_ATTEMPT_POLICY),
      "terminal-mutation": new SlidingWindowRateLimiter(
        policies["terminal-mutation"] ?? TERMINAL_MUTATION_POLICY,
      ),
      "github-read": new SlidingWindowRateLimiter(
        policies["github-read"] ?? GITHUB_READ_POLICY,
      ),
    };
  }

  /**
   * Records one attempt against `surface`. For unauthenticated surfaces `key` is
   * the transport peer address — never a caller-supplied header or body field —
   * and for authenticated surfaces it is the authenticated device id.
   */
  consume(surface: RateLimitedSurface, key: string, nowMs: number): RateLimitDecision {
    return this.limiters[surface].consume(key, nowMs);
  }
}
