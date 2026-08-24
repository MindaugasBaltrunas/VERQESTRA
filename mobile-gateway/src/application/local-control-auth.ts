import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { LocalControlError } from "./local-control-errors.js";

/**
 * Local re-authentication proofs.
 *
 * `local-control-contract.md` requires local re-auth on the loopback fallback
 * and a re-auth proof before any integration changes Git state. Being the local
 * OS user is not enough on its own: it authorises the human, not the program
 * that opened the socket, and on Windows the transport can prove nothing about
 * either. The proof closes that gap with a MAC over the exact request, so a
 * caller must hold the host-private secret AND be talking about the same method,
 * path and body the gateway is about to act on.
 *
 * Header form (`x-ag-local-proof`):
 *
 * ```text
 * v1:<nonce hex>:<ISO-8601 instant>:<mac base64url>
 * mac = HMAC-SHA256(secret, "ag-local-v1\n" + METHOD + "\n" + path + "\n"
 *                         + sha256hex(body) + "\n" + nonce + "\n" + timestamp)
 * ```
 *
 * The domain separator, the method and the path are inside the MAC so a proof
 * captured for a preview cannot be replayed against the confirm that follows it.
 */

const PROOF_DOMAIN = "ag-local-v1";
const CONFIRMATION_DOMAIN = "ag-local-confirm-v1";

/** `v1:<nonce>:<timestamp>:<mac>`; the timestamp's own colons stay unambiguous. */
const PROOF_HEADER =
  /^v1:([0-9a-f]{32,128}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z):([A-Za-z0-9_-]{43})$/;

const DEFAULT_MAX_SKEW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 300_000;
const DEFAULT_MAX_NONCES = 512;

export type LocalProofInput = Readonly<{
  secret: Uint8Array;
  method: string;
  path: string;
  body: Uint8Array | undefined;
  header: string | undefined;
  now: Date;
}>;

function macOf(secret: Uint8Array, transcript: string): Buffer {
  return createHmac("sha256", secret).update(transcript, "utf8").digest();
}

function bodyDigest(body: Uint8Array | undefined): string {
  return createHash("sha256").update(body ?? new Uint8Array()).digest("hex");
}

/** Constant-time comparison that treats a length mismatch as a mismatch, not a throw. */
function macMatches(expected: Buffer, presented: Buffer): boolean {
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/**
 * Verifies one request proof and remembers its nonce.
 *
 * The verifier is stateful because replay protection is: a proof that is valid
 * twice is a proof that authorises a second force-close or a second merge. The
 * nonce cache is bounded and time-limited, and a full cache is reported as
 * `rate_limited` rather than silently forgetting an entry — dropping a
 * remembered nonce to make room is exactly how a replay window reopens.
 */
export class LocalProofVerifier {
  /** nonce -> instant it may be forgotten. */
  private readonly nonces = new Map<string, number>();

  private readonly maxSkewMs: number;
  private readonly nonceTtlMs: number;
  private readonly maxNonces: number;

  constructor(options: Readonly<{
    maxSkewMs?: number;
    nonceTtlMs?: number;
    maxNonces?: number;
  }> = {}) {
    this.maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    this.nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
    this.maxNonces = options.maxNonces ?? DEFAULT_MAX_NONCES;
    if (
      !Number.isSafeInteger(this.maxSkewMs) || this.maxSkewMs <= 0 ||
      !Number.isSafeInteger(this.nonceTtlMs) || this.nonceTtlMs <= 0 ||
      !Number.isSafeInteger(this.maxNonces) || this.maxNonces <= 0
    ) {
      throw new Error("Local proof verifier options are invalid");
    }
  }

  verify(input: LocalProofInput): void {
    const parsed = PROOF_HEADER.exec(input.header ?? "");
    const nonce = parsed?.[1];
    const timestamp = parsed?.[2];
    const presented = parsed?.[3];
    if (!nonce || !timestamp || !presented) {
      throw new LocalControlError("unauthenticated", "Local control proof is missing or malformed");
    }
    const transcript = [
      PROOF_DOMAIN,
      input.method.toUpperCase(),
      input.path,
      bodyDigest(input.body),
      nonce,
      timestamp,
    ].join("\n");
    if (!macMatches(macOf(input.secret, transcript), Buffer.from(presented, "base64url"))) {
      throw new LocalControlError("unauthenticated", "Local control proof is invalid");
    }
    // Freshness is checked only after the MAC: an unauthenticated caller must
    // not learn the host clock from the difference between two refusals.
    const issuedAtMs = Date.parse(timestamp);
    const nowMs = input.now.getTime();
    if (!Number.isFinite(issuedAtMs) || Math.abs(nowMs - issuedAtMs) > this.maxSkewMs) {
      throw new LocalControlError("unauthenticated", "Local control proof is outside the accepted clock skew");
    }
    for (const [candidate, expiresAtMs] of this.nonces) {
      if (expiresAtMs <= nowMs) {
        this.nonces.delete(candidate);
      }
    }
    if (this.nonces.has(nonce)) {
      throw new LocalControlError("unauthenticated", "Local control proof was already used");
    }
    if (this.nonces.size >= this.maxNonces) {
      throw new LocalControlError("rate_limited", "Local control proof cache is full");
    }
    this.nonces.set(nonce, nowMs + this.nonceTtlMs);
  }
}

export type IntegrationConfirmationBinding = Readonly<{
  integrationId: string;
  diffDigest: string;
  gateDigest: string;
}>;

/**
 * The re-auth proof carried inside an integration confirmation.
 *
 * It is bound to the integration id AND to both digests, so a proof produced for
 * one preview cannot approve a different diff or a different gate outcome even
 * within the same session.
 */
export function integrationConfirmationProof(
  secret: Uint8Array,
  input: IntegrationConfirmationBinding,
): string {
  return macOf(
    secret,
    [CONFIRMATION_DOMAIN, input.integrationId, input.diffDigest, input.gateDigest].join("\n"),
  ).toString("base64url");
}

/** Constant-time check of {@link integrationConfirmationProof}; never throws. */
export function verifyIntegrationConfirmation(
  secret: Uint8Array,
  input: IntegrationConfirmationBinding,
  confirmation: string,
): boolean {
  try {
    return macMatches(
      Buffer.from(integrationConfirmationProof(secret, input), "utf8"),
      Buffer.from(confirmation, "utf8"),
    );
  } catch {
    return false;
  }
}
