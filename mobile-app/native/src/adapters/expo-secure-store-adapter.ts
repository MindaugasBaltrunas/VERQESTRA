/**
 * Platform secure storage for the native shell — the missing half of
 * `SecureStorePort` (`mobile-app/src/model/ports.ts`).
 *
 * The MVC core declares the port but may not implement it: the OS keystore is
 * only reachable through the `expo` package family, which `mvc-boundaries.test.ts`
 * forbids the core to import by name. So the implementation belongs here, on the
 * native side, and nowhere else.
 *
 * This file imports `expo-secure-store` NOWHERE. The module arrives as a
 * constructor argument narrowed to the three calls actually used, which buys two
 * things: the composition root owns the real dependency (one place to audit), and
 * this module stays loadable under a plain `node --test` run, where no Expo native
 * module exists. Every other native suite has to read its subject as text for
 * exactly that reason; this one is tested by construction instead.
 */

/**
 * `expo-secure-store`'s `KeychainAccessibilityConstant`, restated as the numeric
 * type it is. Declared rather than imported so this module keeps no build-time
 * dependency; `native-runtime.ts` passes the real constant through.
 */
export type KeychainAccessibility = number;

export interface ExpoSecureStoreOptions {
  readonly keychainAccessible?: KeychainAccessibility;
  readonly keychainService?: string;
}

/**
 * Exactly the `expo-secure-store` surface this adapter calls — no more, so a
 * test double stays small and an unused API cannot creep in unnoticed. Method
 * syntax is deliberate: it makes the real module structurally assignable here
 * without importing its types.
 */
export interface ExpoSecureStoreModule {
  getItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: ExpoSecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<void>;
}

/**
 * Structurally identical to the core's `SecureStorePort`, restated locally
 * because importing it would drag `../core` — and with it the whole
 * `@verqestra/mobile-app` resolution seam — into a file that must stay
 * importable without Metro. `native-runtime.ts` annotates the factory result as
 * `SecureStorePort`, so the two shapes are checked against each other at compile
 * time in the one place that can see both.
 *
 * `key` is `string`, not the core's closed `SecureStoreKey` union, and that is
 * the honest type for a platform adapter: the keystore takes an opaque string,
 * and narrowing the slot namespace is the core's job, not this layer's.
 */
export interface NativeSecureStore {
  readSecret(key: string): Promise<string | null>;
  writeSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export type SecureStoreOperation = "read" | "write" | "delete";

/**
 * A keystore call that failed for a reason other than "no such key". Carries the
 * slot name — an enumerable, non-secret identifier — and never the value: a
 * rotated refresh token must not reach an error string that could be logged,
 * shown or sent to a crash reporter.
 */
export class ExpoSecureStoreError extends Error {
  constructor(
    readonly operation: SecureStoreOperation,
    readonly key: string,
    cause: unknown,
  ) {
    super(`expo-secure-store ${operation} failed for "${key}"`, { cause });
    this.name = "ExpoSecureStoreError";
  }
}

export interface ExpoSecureStoreAdapterOptions {
  readonly module: ExpoSecureStoreModule;
  /**
   * Required, with no default: how long the OS may keep the item readable is a
   * security decision, and an adapter that picked one silently would decide it
   * for every caller. `native-runtime.ts` passes
   * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which keeps pairing credentials out of
   * device backups and off any restored second device.
   */
  readonly keychainAccessible: KeychainAccessibility;
  /** iOS keychain service; must match between write and read, hence one value for both. */
  readonly keychainService?: string;
}

export function createExpoSecureStoreAdapter(
  options: ExpoSecureStoreAdapterOptions,
): NativeSecureStore {
  const secureStore = options.module;
  const service = options.keychainService === undefined
    ? {}
    : { keychainService: options.keychainService };
  // `keychainAccessible` is meaningful only when the item is created; on read and
  // delete the lookup key is the service, so passing an accessibility class there
  // would suggest a guarantee those calls do not make.
  const lookupOptions: ExpoSecureStoreOptions = { ...service };
  const writeOptions: ExpoSecureStoreOptions = {
    keychainAccessible: options.keychainAccessible,
    ...service,
  };

  return {
    async readSecret(key: string): Promise<string | null> {
      let raw: string | null;
      try {
        raw = await secureStore.getItemAsync(key, lookupOptions);
      } catch (cause) {
        // Deliberately NOT `return null`. An absent slot and an unreadable one
        // are different facts: reporting a decryption or keychain failure as
        // "not paired" would send the operator into a re-pairing loop that
        // overwrites the very item that failed to read.
        throw new ExpoSecureStoreError("read", key, cause);
      }
      // A missing key is not an exception — the port contract says so, and
      // `expo-secure-store` agrees by returning null. Normalised because an
      // absent native value has arrived as `undefined` across module versions.
      return raw ?? null;
    },

    async writeSecret(key: string, value: string): Promise<void> {
      try {
        await secureStore.setItemAsync(key, value, writeOptions);
      } catch (cause) {
        throw new ExpoSecureStoreError("write", key, cause);
      }
    },

    async deleteSecret(key: string): Promise<void> {
      try {
        // Idempotent by contract: `deleteItemAsync` resolves for an absent key,
        // so clearing a credential twice is not an error.
        await secureStore.deleteItemAsync(key, lookupOptions);
      } catch (cause) {
        throw new ExpoSecureStoreError("delete", key, cause);
      }
    },
  };
}
