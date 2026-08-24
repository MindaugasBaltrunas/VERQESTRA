import type { Provider } from "./state.js";
import type { SpeechTranscriptionMode, SpeechUnavailableReason } from "./voice.js";

export type TerminalLease = Readonly<{
  leaseId: string;
  ownerDeviceId: string;
  generation: number;
  expiresAt: string;
}>;

export type TerminalSession = Readonly<{
  sessionId: string;
  projectId: string;
  provider: Provider;
  workspaceMode: "isolated-worktree";
  branch: string;
  state: "creating" | "starting" | "live" | "interrupting" | "closing" | "ended" | "failed" | "orphaned";
  lease: TerminalLease;
  nextSequence: number;
}>;

export interface GatewayPort {
  createTerminalSession(input: Readonly<{
    projectId: string;
    provider: Provider;
    workspaceMode: "isolated-worktree";
    cols: number;
    rows: number;
  }>): Promise<TerminalSession>;
  getTerminalSession(input: Readonly<{
    projectId: string;
    sessionId: string;
  }>): Promise<TerminalSession>;
  writeTerminalInput(input: Readonly<{
    projectId: string;
    sessionId: string;
    lease: TerminalLease;
    text: string;
    source: "keyboard" | "voice";
  }>): Promise<Readonly<{
    inputId: string;
    status: "accepted" | "written" | "rejected" | "unknown";
  }>>;
  resizeTerminal(input: Readonly<{
    projectId: string;
    sessionId: string;
    lease: TerminalLease;
    cols: number;
    rows: number;
  }>): Promise<void>;
  signalTerminal(input: Readonly<{
    projectId: string;
    sessionId: string;
    lease: TerminalLease;
    signal: "interrupt" | "terminate";
  }>): Promise<TerminalSession | undefined>;
  closeTerminal(input: Readonly<{
    projectId: string;
    sessionId: string;
    lease: TerminalLease;
  }>): Promise<TerminalSession>;
}

/**
 * What the device can do about speech right now. `reason` is non-null exactly
 * when `available` is false, so an unavailable recogniser can never be reported
 * without a reason the operator can act on.
 */
export type SpeechCapability = Readonly<{
  available: boolean;
  /** The backend this device would use *now*, not a preference. */
  mode: SpeechTranscriptionMode;
  reason: SpeechUnavailableReason | null;
  onDeviceSupported: boolean;
}>;

export type SpeechPartialResult = Readonly<{ text: string; confidence: number | null }>;

export type SpeechFinalResult = Readonly<{
  text: string;
  mode: SpeechTranscriptionMode;
  confidence: number | null;
}>;

/**
 * Handle on one press-and-hold capture. Both methods are idempotent, because a
 * release and a cancel can reach the same capture from two different gestures.
 */
export type SpeechCaptureHandle = Readonly<{
  stop(): Promise<SpeechFinalResult>;
  /** Discards the capture. Never rejects: cancelling is not a failure. */
  cancel(): Promise<void>;
}>;

export interface SpeechRecognitionPort {
  /** A capability check only; it never opens the microphone. */
  probe(): Promise<SpeechCapability>;
  /**
   * Starts one capture. `allowCloud === false` forbids a cloud backend outright:
   * an implementation that would transcribe off-device must reject instead of
   * silently sending audio the operator did not consent to.
   */
  startCapture(input: Readonly<{
    allowCloud: boolean;
    locale: string;
    onPartial(result: SpeechPartialResult): void;
  }>): Promise<SpeechCaptureHandle>;
}

/** Persistence of the operator's cloud-transcription consent, nothing else. */
export interface SpeechConsentPort {
  readCloudConsent(): Promise<boolean>;
  writeCloudConsent(granted: boolean): Promise<void>;
}

export type DeviceCredential = Readonly<{
  deviceId: string;
  generation: number;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}>;

export interface CredentialPort {
  loadDeviceCredential(): Promise<DeviceCredential | null>;
  storeDeviceCredential(value: DeviceCredential): Promise<void>;
  clearDeviceCredential(): Promise<void>;
}

export interface DeviceProofPort {
  createRefreshProof(input: Readonly<{
    deviceId: string;
    generation: number;
    refreshToken: string;
  }>): Promise<Readonly<{ nonce: string; proof: string }>>;
}

/**
 * Every slot this app may occupy in the OS keystore. The union is closed so the
 * whole persisted-secret surface stays enumerable in one place and a typo cannot
 * silently create an unaudited slot.
 */
export type SecureStoreKey =
  | "device.credential"
  | "device.key-alias"
  | "device.host-fingerprint"
  | "speech.cloud-consent";

/**
 * OS-backed secret storage (Keychain/Keystore). Values are opaque strings the
 * port never parses; the platform-neutral adapters own validation, so a stored
 * blob can never be interpreted differently by two callers.
 */
export interface SecureStorePort {
  readSecret(key: SecureStoreKey): Promise<string | null>;
  writeSecret(key: SecureStoreKey, value: string): Promise<void>;
  deleteSecret(key: SecureStoreKey): Promise<void>;
}

/**
 * Everything JavaScript is allowed to know about a device key: an opaque
 * keystore alias and the public half. There is deliberately no accessor for
 * private key material, so no adapter, error, view state or crash report can
 * carry it out of the secure enclave.
 */
export type DeviceKeyHandle = Readonly<{
  /** Keystore alias. An identifier, not key material and not a secret. */
  alias: string;
  /** Ed25519 public key, base64url DER SPKI, exactly as the gateway expects. */
  publicKey: string;
}>;

export interface DeviceKeyPort {
  /** Creates a non-exportable Ed25519 key pair inside the OS keystore. */
  createDeviceKey(): Promise<DeviceKeyHandle>;
  /** Signs the UTF-8 bytes of `transcript` in the keystore; base64url, unpadded. */
  signTranscript(input: Readonly<{ alias: string; transcript: string }>): Promise<string>;
  /** Idempotent: removing an already absent key is not an error. */
  deleteDeviceKey(alias: string): Promise<void>;
}

/**
 * Randomness and digests the core needs but must not implement itself: React
 * Native has no `node:crypto`, and `Math.random` is not a nonce source.
 */
export interface DeviceCryptoPort {
  /** Cryptographically strong random bytes, base64url, unpadded. */
  randomBase64Url(byteLength: number): Promise<string>;
  /** SHA-256 over the UTF-8 bytes of `value`, base64url, unpadded. */
  sha256Base64Url(value: string): Promise<string>;
}

export type BiometricUnlockOutcome =
  | "unlocked"
  | "denied"
  | "unavailable"
  | "not-enrolled"
  | "locked-out";

export interface BiometricAuthenticatorPort {
  /** Whether a biometric check can be attempted at all on this device, right now. */
  isAvailable(): Promise<boolean>;
  /** `reason` is user-visible prompt text supplied by the shell; never a secret. */
  authenticate(input: Readonly<{ reason: string }>): Promise<BiometricUnlockOutcome>;
}

/** Terminal operations that mutate host state and therefore need confirmation. */
export type TerminalWriteAction =
  | "start"
  | "input"
  | "resize"
  | "interrupt"
  | "terminate"
  | "close";

/**
 * Authorisation gate in front of every terminal mutation. It resolves only when
 * the write is confirmed and rejects otherwise, so a caller that forgets to
 * handle the rejection still fails closed rather than writing unconfirmed.
 */
export interface TerminalWriteGatePort {
  requireUnlock(action: TerminalWriteAction): Promise<void>;
  /**
   * Drops any open unlock window. Called when the operator leaves the terminal
   * — session close and stream detach today — and by any shell that learns the
   * app was backgrounded or the device credential was revoked.
   */
  lock(): void;
}

/**
 * The push-notification payload, mirrored from the gateway's closed contract.
 *
 * It is restated here rather than imported because the two packages may not
 * depend on each other; the mirror is deliberately the *whole* contract, so a
 * field the gateway never sends cannot be invented on this side either. The
 * side that owns the contract is the gateway's
 * `src/application/ports/push-notification-port.ts` — a change there is a
 * change here, and this comment is the only pointer a reader gets, because no
 * test may read across the two packages to catch the drift for us. A
 * notification says that something ended and which opaque subject it was about
 * — never a path, a diff, terminal output or any credential.
 */
export type PushNotificationEventType = "failed" | "completed";
export type PushNotificationSource = "ag-loop-read" | "mobile-terminal";

export type PushNotificationPayload = Readonly<{
  type: PushNotificationEventType;
  source: PushNotificationSource;
  /** Opaque AG Loop task id or mobile terminal session id — never a path, never content. */
  subjectId: string;
  /** ISO-8601 UTC instant. */
  occurredAt: string;
}>;

/** Cancels a delivery subscription. Idempotent: a second call is not an error. */
export type PushNotificationUnsubscribe = () => void;

/**
 * Inbound-only delivery of push notifications from the OS.
 *
 * There is deliberately no `send`: the app is a receiver, and the decision to
 * notify stays on the gateway, so no screen, adapter or shell of this package
 * can originate a notification or address another device. `delivered` is
 * `unknown` on purpose — it is whatever the platform hands over, and it is the
 * adapter's job to prove it is a payload before anything reads a field of it.
 */
export interface PushNotificationDeliveryPort {
  subscribe(listener: (delivered: unknown) => void): PushNotificationUnsubscribe;
}
