import type {
  LocalDeviceRevokeIntent,
  LocalForceCloseIntent,
} from "../domain/command-intent.js";
import { DEVICE_SCOPES } from "../domain/device-auth.js";
import type { DeviceAuthService } from "./device-auth-service.js";
import { LocalControlError } from "./local-control-errors.js";
import type { TerminalSessionSnapshot, TerminalSupervisor } from "./terminal-supervisor.js";

/**
 * The host-owner operations of `local-control-contract.md` that are not the
 * integration flow: issuing a pairing challenge, forcing a session closed and
 * revoking a device.
 *
 * What binds them together is that each one is an OWNER decision with a lasting
 * effect, which is why the request-id ledger lives here rather than in the
 * supervisor or the transport: replaying a force-close must not terminate a
 * second session that happens to be live by then, and replaying a revoke must
 * not report a second, empty fence.
 *
 * The one-time pairing code is handled with the same care the remote surface
 * gives a credential: it is returned inside the QR payload and nowhere else —
 * not in a field of its own, not in the audit record, not in any state this
 * service keeps.
 */

export type PairingChallengeView = Readonly<{
  challengeId: string;
  /** Opaque display value; the only place the one-time code appears. */
  qrPayload: string;
  hostFingerprint: string;
  expiresAt: string;
}>;

export type DeviceRevocationResult = Readonly<{
  deviceId: string;
  revokedSessionIds: readonly string[];
}>;

export type LocalControlDependencies = Readonly<{
  deviceAuth: DeviceAuthService;
  terminals: TerminalSupervisor;
  hostFingerprint: () => string;
  pairingOrigin: () => string;
  clock?: () => Date;
  /** Optional composition hook: closes live streams of the sessions a revoke fenced. */
  disconnectStreams?: (sessionIds: readonly string[], reason: string) => Promise<void>;
}>;

type LedgerRecord = {
  fingerprint: string;
  createdAtMs: number;
  result: Promise<unknown>;
};

const REQUEST_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_RECORDS = 1024;
const MAX_DEVICE_NAME_LENGTH = 80;
const MAX_REASON_LENGTH = 200;
const QR_PAYLOAD_VERSION = 1;

export class LocalControlService {
  private readonly requests = new Map<string, LedgerRecord>();

  private readonly deviceAuth: DeviceAuthService;
  private readonly terminals: TerminalSupervisor;
  private readonly hostFingerprint: () => string;
  private readonly pairingOrigin: () => string;
  private readonly clock: () => Date;
  // `| undefined`, ne `?`: laukas priskiriamas besąlygiškai iš neprivalomos priklausomybės.
  private readonly disconnectStreams:
    | ((sessionIds: readonly string[], reason: string) => Promise<void>)
    | undefined;

  constructor(dependencies: LocalControlDependencies) {
    this.deviceAuth = dependencies.deviceAuth;
    this.terminals = dependencies.terminals;
    this.hostFingerprint = dependencies.hostFingerprint;
    this.pairingOrigin = dependencies.pairingOrigin;
    this.clock = dependencies.clock ?? (() => new Date());
    this.disconnectStreams = dependencies.disconnectStreams;
  }

  /**
   * Runs `operation` once per request id.
   *
   * A repeat with the same request id gets the first outcome. A repeat with the
   * same id but a different subject is a client bug or a replay against another
   * target, and is refused instead of served. A failed attempt releases its slot
   * so an operator can retry a recovery action that did not happen.
   */
  private async once<T>(
    requestId: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new LocalControlError("duplicate_request", "Request id was reused for another operation");
      }
      return await (existing.result as Promise<T>);
    }
    const nowMs = this.clock().getTime();
    for (const [candidate, record] of this.requests) {
      if (nowMs - record.createdAtMs >= REQUEST_LEDGER_TTL_MS) {
        this.requests.delete(candidate);
      }
    }
    if (this.requests.size >= MAX_REQUEST_RECORDS) {
      throw new LocalControlError("rate_limited", "Local request ledger is full");
    }
    const result = operation();
    this.requests.set(requestId, { fingerprint, createdAtMs: nowMs, result });
    result.catch(() => {
      const current = this.requests.get(requestId);
      if (current?.result === result) {
        this.requests.delete(requestId);
      }
    });
    return await result;
  }

  async createPairingChallenge(input: {
    deviceName: string;
    scopes: readonly string[];
  }): Promise<PairingChallengeView> {
    const deviceName = input.deviceName.trim();
    if (deviceName.length === 0 || deviceName.length > MAX_DEVICE_NAME_LENGTH) {
      throw new LocalControlError("invalid_request", "Device name is invalid");
    }
    const scopes = [...input.scopes];
    if (
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !(DEVICE_SCOPES as readonly string[]).includes(scope))
    ) {
      throw new LocalControlError("invalid_request", "Pairing scopes are invalid");
    }
    const challenge = await this.deviceAuth.createPairingChallenge({
      hostFingerprint: this.hostFingerprint(),
      scopes,
      now: this.clock(),
    });
    // The code lives only inside the payload the operator shows to the phone.
    // Nothing else in this method — and nothing downstream — sees it again.
    const qrPayload = Buffer.from(JSON.stringify({
      v: QR_PAYLOAD_VERSION,
      origin: this.pairingOrigin(),
      challengeId: challenge.challengeId,
      hostFingerprint: challenge.hostFingerprint,
      code: challenge.oneTimeCode,
    }), "utf8").toString("base64url");
    return Object.freeze({
      challengeId: challenge.challengeId,
      qrPayload,
      hostFingerprint: challenge.hostFingerprint,
      expiresAt: challenge.expiresAt,
    });
  }

  async forceCloseSession(intent: LocalForceCloseIntent): Promise<TerminalSessionSnapshot> {
    this.assertReason(intent.reason);
    return this.once(
      intent.requestId,
      `force-close:${intent.sessionId}:${intent.expectedSessionRevision}`,
      () => this.terminals.forceCloseLocally({
        sessionId: intent.sessionId,
        requestId: intent.requestId,
        reason: intent.reason,
        expectedSessionRevision: intent.expectedSessionRevision,
      }),
    );
  }

  /**
   * Revocation order is not incidental: credentials first, then leases, then
   * live streams. Cutting the streams first would leave a device that can
   * reconnect with a token that is still valid.
   */
  async revokeDevice(intent: LocalDeviceRevokeIntent): Promise<DeviceRevocationResult> {
    this.assertReason(intent.reason);
    return this.once(intent.requestId, `revoke:${intent.deviceId}`, async () => {
      await this.deviceAuth.revokeDevice(intent.deviceId, this.clock());
      const revokedSessionIds = await this.terminals.revokeDeviceLeases(intent.deviceId);
      if (this.disconnectStreams) {
        await this.disconnectStreams(revokedSessionIds, intent.reason);
      }
      return Object.freeze({ deviceId: intent.deviceId, revokedSessionIds });
    });
  }

  private assertReason(reason: string): void {
    if (reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH) {
      throw new LocalControlError("invalid_request", "Reason is required and must be short");
    }
  }
}
