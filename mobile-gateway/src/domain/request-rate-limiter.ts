/**
 * Sliding-window attempt limiter for the gateway's unauthenticated surfaces.
 *
 * `threat-model.md` requires rate limits as a denial-of-service control, and
 * `verification-matrix.md` budgets pairing redemption at five attempts per ten
 * minutes per source. Both the pairing and the refresh route run Ed25519 proof
 * verification before they can reject a caller, so an unthrottled attacker gets
 * free asymmetric-crypto work on the host.
 *
 * The limiter is pure and clock-injected: callers pass the current epoch
 * milliseconds so the decision is reproducible in tests and identical across
 * transports.
 */

export type RateLimitDecision = Readonly<{
  allowed: boolean;
  /** Seconds the caller must wait before the next attempt can succeed. `0` when allowed. */
  retryAfterSeconds: number;
}>;

export type RateLimitPolicy = Readonly<{
  /** Attempts permitted inside one window. */
  limit: number;
  windowMs: number;
  /**
   * Upper bound on distinct tracked keys. The key is attacker-controlled
   * (source address), so the limiter must not become the memory-exhaustion
   * vector it exists to prevent.
   */
  maxTrackedKeys: number;
}>;

const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Pairing redemption budget from `verification-matrix.md`. */
export const PAIRING_ATTEMPT_POLICY: RateLimitPolicy = Object.freeze({
  limit: 5,
  windowMs: TEN_MINUTES_MS,
  maxTrackedKeys: 4096,
});

/**
 * Refresh is a legitimate recurring call for every paired device (access tokens
 * live 15 minutes), so its budget is looser than pairing while still bounding
 * offline proof-guessing against a stolen refresh token.
 */
export const REFRESH_ATTEMPT_POLICY: RateLimitPolicy = Object.freeze({
  limit: 30,
  windowMs: TEN_MINUTES_MS,
  maxTrackedKeys: 4096,
});

function assertPolicy(policy: RateLimitPolicy): void {
  if (
    !Number.isSafeInteger(policy.limit) ||
    policy.limit < 1 ||
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1 ||
    !Number.isSafeInteger(policy.maxTrackedKeys) ||
    policy.maxTrackedKeys < 1
  ) {
    throw new Error("Rate limit policy must use positive integers");
  }
}

export class SlidingWindowRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly policy: RateLimitPolicy) {
    assertPolicy(policy);
  }

  /**
   * Records one attempt for `key` and reports whether it may proceed. A denied
   * attempt is deliberately NOT recorded: the window must drain on its own so a
   * throttled caller can recover instead of extending its own lockout forever.
   */
  consume(key: string, nowMs: number): RateLimitDecision {
    const windowStart = nowMs - this.policy.windowMs;
    const recorded = this.attempts.get(key);
    const timestamps = recorded ? recorded.filter((entry) => entry > windowStart) : [];

    if (timestamps.length >= this.policy.limit) {
      this.attempts.set(key, timestamps);
      const oldest = timestamps[0] ?? nowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.policy.windowMs - nowMs) / 1000)),
      };
    }

    if (!recorded && this.attempts.size >= this.policy.maxTrackedKeys) {
      this.evictExpired(windowStart);
      if (this.attempts.size >= this.policy.maxTrackedKeys) {
        // Fail closed: refusing a new source is recoverable, exceeding the
        // tracking bound is not.
        return { allowed: false, retryAfterSeconds: Math.ceil(this.policy.windowMs / 1000) };
      }
    }

    timestamps.push(nowMs);
    this.attempts.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private evictExpired(windowStart: number): void {
    for (const [key, timestamps] of this.attempts) {
      const live = timestamps.filter((entry) => entry > windowStart);
      if (live.length === 0) {
        this.attempts.delete(key);
      } else {
        this.attempts.set(key, live);
      }
    }
  }
}
