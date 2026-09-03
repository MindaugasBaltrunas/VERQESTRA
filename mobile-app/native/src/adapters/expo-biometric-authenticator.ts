/**
 * Platform biometric confirmation for the native shell — the missing half of
 * `BiometricAuthenticatorPort` (`mobile-app/src/model/ports.ts`).
 *
 * The MVC core declares the port but may not implement it: a fingerprint or face
 * check is only reachable through the `expo` package family, which
 * `mvc-boundaries.test.ts` forbids the core to import by name. So the
 * implementation belongs here, on the native side, and nowhere else.
 *
 * This file imports `expo-local-authentication` NOWHERE, for the same reason
 * `expo-secure-store-adapter.ts` names no module: the composition root owns the
 * real dependency (one place to audit), and this module stays loadable under a
 * plain `node --test` run, where no Expo native module exists. Every other
 * native suite has to read its subject as text; this one is tested by
 * construction instead.
 */

/**
 * Exactly the `expo-local-authentication` call surface this adapter uses — no
 * more, so a test double stays small and an unused API cannot creep in
 * unnoticed. Method syntax is deliberate: it makes the real module structurally
 * assignable here without importing its types.
 */
export interface ExpoLocalAuthenticationOptions {
  readonly promptMessage?: string;
  /**
   * `true` here: the port is a *biometric* authenticator, and the device
   * passcode is the credential that already unlocked the phone. Accepting it as
   * the confirmation would let a shoulder-surfed PIN authorise host writes,
   * which is the substitution this gate exists to prevent.
   */
  readonly disableDeviceFallback?: boolean;
}

export type ExpoLocalAuthenticationResult =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; warning?: string }>;

export interface ExpoLocalAuthenticationModule {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(options: ExpoLocalAuthenticationOptions): Promise<ExpoLocalAuthenticationResult>;
}

/**
 * Structurally identical to the core's `BiometricUnlockOutcome`, restated
 * locally for the same reason `NativeSecureStore` restates `SecureStorePort`:
 * importing it would drag `../core` — and with it the whole
 * `@verqestra/mobile-app` resolution seam — into a file that must stay
 * importable without Metro. `native-runtime.ts` annotates the factory result as
 * `BiometricAuthenticatorPort`, so the two shapes are checked against each other
 * at compile time in the one place that can see both.
 */
export type NativeBiometricUnlockOutcome =
  | "unlocked"
  | "denied"
  | "unavailable"
  | "not-enrolled"
  | "locked-out";

export interface NativeBiometricAuthenticator {
  isAvailable(): Promise<boolean>;
  authenticate(input: Readonly<{ reason: string }>): Promise<NativeBiometricUnlockOutcome>;
}

/**
 * `expo-local-authentication`'s failure strings mapped onto the port's outcomes.
 *
 * Only the three the caller can act on differently are distinguished: missing
 * hardware or entitlement is `unavailable`, an empty enrolment is
 * `not-enrolled`, and a throttled sensor is `locked-out`. Everything else —
 * cancel, timeout, a failed match, the passcode fallback the prompt was told not
 * to offer — is a plain `denied`, because none of them says anything about the
 * device that would change what the operator should do next.
 *
 * The map is deliberately not exhaustive over the module's error union: an error
 * string this table does not know falls through to `denied` below, so a new
 * failure mode shipped by a future Expo version denies the write instead of
 * arriving unclassified.
 */
const outcomeByError: ReadonlyMap<string, NativeBiometricUnlockOutcome> = new Map([
  ["not_available", "unavailable" as const],
  ["not_enrolled", "not-enrolled" as const],
  ["passcode_not_set", "unavailable" as const],
  ["missing_usage_description", "unavailable" as const],
  ["invalid_context", "unavailable" as const],
  ["lockout", "locked-out" as const],
  ["lockout_permanent", "locked-out" as const],
]);

export interface ExpoBiometricAuthenticatorOptions {
  readonly module: ExpoLocalAuthenticationModule;
  /**
   * Optional escape hatch for a shell that must accept the device credential —
   * `false` weakens the guard, so it has no default and must be written down at
   * the wiring site to take effect.
   */
  readonly allowDeviceFallback?: boolean;
}

/**
 * `BiometricAuthenticatorPort` over `expo-local-authentication`.
 *
 * Both methods are total: a platform call that throws is reported as "not
 * available" / "denied" rather than propagated. That is not swallowing an error
 * the way `expo-secure-store-adapter.ts` refuses to — there, an unreadable slot
 * and an absent one are different facts and the caller must tell them apart.
 * Here the port's return type already enumerates every denial, so the honest
 * answer to "did the operator confirm?" after a failed platform call is "no".
 * No path returns `unlocked` without an explicit `success: true`.
 */
export function createExpoBiometricAuthenticator(
  options: ExpoBiometricAuthenticatorOptions,
): NativeBiometricAuthenticator {
  const localAuthentication = options.module;
  const disableDeviceFallback = options.allowDeviceFallback !== true;

  return {
    async isAvailable(): Promise<boolean> {
      try {
        // Enrolment is part of the question the port asks — "can a check be
        // attempted right now". With the device fallback disabled, a sensor with
        // nothing enrolled has no credential to compare against, so a prompt
        // there could only fail.
        if (await localAuthentication.hasHardwareAsync() !== true) return false;
        return await localAuthentication.isEnrolledAsync() === true;
      } catch {
        return false;
      }
    },

    async authenticate(input: Readonly<{ reason: string }>): Promise<NativeBiometricUnlockOutcome> {
      let result: ExpoLocalAuthenticationResult;
      try {
        result = await localAuthentication.authenticateAsync({
          // The prompt copy comes from the shell through the gate; this adapter
          // neither invents nor edits it, and it is never a secret.
          promptMessage: input.reason,
          disableDeviceFallback,
        });
      } catch {
        return "denied";
      }
      // `success` is checked positively: a malformed result from a module version
      // this shape does not match is a denial, not an unlock.
      if (result.success === true) return "unlocked";
      return outcomeByError.get(result.error) ?? "denied";
    },
  };
}
