import type {
  BiometricAuthenticatorPort,
  BiometricUnlockOutcome,
  TerminalWriteAction,
  TerminalWriteGatePort,
} from "../../model/ports.js";

export const defaultUnlockWindowMs = 120_000;
export const minimumUnlockWindowMs = 1_000;
/**
 * Never longer than the gateway's 15-minute access-token lifetime: an unlock
 * that outlives the credential it authorises is a window with nothing behind it.
 */
export const maximumUnlockWindowMs = 300_000;

export class BiometricGateError extends Error {
  constructor(readonly outcome: Exclude<BiometricUnlockOutcome, "unlocked">, message: string) {
    super(message);
    this.name = "BiometricGateError";
  }
}

/**
 * Requires a biometric confirmation before a terminal write reaches the host.
 *
 * The unlock window is deliberately not sliding: it is stamped when the operator
 * confirms and is never extended by later gated calls, so a phone taken while
 * unlocked cannot be held open by typing. Every path that is not an explicit
 * `"unlocked"` — unavailable hardware, no enrolment, cancel, lockout, or an
 * adapter that throws — denies the write.
 */
export class BiometricWriteGate implements TerminalWriteGatePort {
  private unlockedAtMs: number | undefined;

  constructor(
    private readonly authenticator: BiometricAuthenticatorPort,
    private readonly nowMs: () => number,
    /** Prompt copy per action, supplied by the shell so UI text stays out of the core. */
    private readonly reasons: Readonly<Record<TerminalWriteAction, string>>,
    private readonly windowMs: number = defaultUnlockWindowMs,
  ) {
    if (
      !Number.isSafeInteger(windowMs) ||
      windowMs < minimumUnlockWindowMs ||
      windowMs > maximumUnlockWindowMs
    ) {
      throw new RangeError("Biometric unlock window is out of range");
    }
  }

  async requireUnlock(action: TerminalWriteAction): Promise<void> {
    if (this.isWindowOpen()) return;
    this.unlockedAtMs = undefined;
    let available: boolean;
    try {
      available = await this.authenticator.isAvailable();
    } catch {
      throw new BiometricGateError("unavailable", "Biometric confirmation is unavailable");
    }
    if (available !== true) {
      // No prompt is attempted: without biometrics there is no confirmation to
      // obtain, and continuing anyway would be the fail-open this gate exists
      // to prevent.
      throw new BiometricGateError("unavailable", "Biometric confirmation is unavailable");
    }
    let outcome: BiometricUnlockOutcome;
    try {
      outcome = await this.authenticator.authenticate({ reason: this.reasons[action] });
    } catch {
      // A throwing authenticator is a denial, never an implicit success.
      throw new BiometricGateError("denied", "Biometric confirmation failed");
    }
    if (outcome !== "unlocked") {
      throw new BiometricGateError(
        outcome === "denied" || outcome === "unavailable" ||
          outcome === "not-enrolled" || outcome === "locked-out"
          ? outcome
          : "denied",
        "Biometric confirmation was not granted",
      );
    }
    this.unlockedAtMs = this.nowMs();
  }

  lock(): void {
    this.unlockedAtMs = undefined;
  }

  private isWindowOpen(): boolean {
    if (this.unlockedAtMs === undefined) return false;
    const now = this.nowMs();
    // The lower bound matters: a clock moved backwards must invalidate the
    // window rather than appear to extend it indefinitely.
    return now >= this.unlockedAtMs && now < this.unlockedAtMs + this.windowMs;
  }
}
