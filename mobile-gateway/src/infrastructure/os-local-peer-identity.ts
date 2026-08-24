import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  LocalControlEndpoint,
  LocalPeerAssurance,
  LocalPeerAttestation,
  LocalPeerContext,
  LocalPeerIdentityPort,
} from "../application/ports/local-peer-identity-port.js";

/**
 * What this host can actually prove about a local caller.
 *
 * The adapter observes and reports; it never decides. That split matters most
 * where the platforms diverge:
 *
 * - **POSIX**: the socket lives in a directory owned by the gateway's user with
 *   no group or other permissions, so the kernel itself refuses every other
 *   account. That is a real access-control decision — `os-acl-verified`.
 * - **Windows**: Node cannot set a DACL on a named pipe it creates, so the pipe
 *   is reachable by other accounts on the machine. Nothing about the ENDPOINT
 *   can be verified, and the boundary rests entirely on the owner-only secret
 *   file. It is reported as `capability-only` so a composition has to opt into
 *   that weaker level explicitly rather than inherit it.
 * - **Loopback fallback**: a TCP port proves nothing about the peer beyond its
 *   address, so it is `capability-only` too, with the loopback address recorded
 *   from what the kernel reported for the accepted connection.
 *
 * Any failure to observe becomes `unverified` with every flag false. A peer the
 * host could not examine is not a peer the host may trust.
 */

/** Bytes of the local control secret; a file of another size is not ours. */
const SECRET_FILE_BYTES = 32;

/** No permission for group or other. */
const OWNER_ONLY_MASK = 0o077;

function ownerUid(): number | undefined {
  // `process.getuid` is absent on Windows, where file modes carry no meaning
  // either; both checks are skipped together rather than half-applied.
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function ownedByGateway(stats: Stats, uid: number | undefined): boolean {
  if (uid === undefined) {
    return true;
  }
  return stats.uid === uid && (stats.mode & OWNER_ONLY_MASK) === 0;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function createOsLocalPeerIdentity(input: {
  secretFile: string;
  now?: () => Date;
}): LocalPeerIdentityPort {
  const clock = input.now ?? (() => new Date());

  async function secretFileGuarded(): Promise<boolean> {
    // `lstat`, never `stat`: a symbolic link pointing at an owner-only file is
    // still a link an attacker may be able to repoint.
    const stats = await lstat(input.secretFile);
    return stats.isFile() && stats.size === SECRET_FILE_BYTES && ownedByGateway(stats, ownerUid());
  }

  async function endpointDirectoryGuarded(path: string): Promise<boolean> {
    const stats = await lstat(dirname(path));
    return stats.isDirectory() && ownedByGateway(stats, ownerUid());
  }

  return {
    async attest(
      endpoint: LocalControlEndpoint,
      context?: LocalPeerContext,
    ): Promise<LocalPeerAttestation> {
      const observedAt = clock().toISOString();
      try {
        const guardedSecret = await secretFileGuarded();
        if (endpoint.kind === "unix-socket") {
          const ownerVerified = await endpointDirectoryGuarded(endpoint.path);
          const assurance: LocalPeerAssurance = ownerVerified && guardedSecret
            ? "os-acl-verified"
            : "unverified";
          return Object.freeze({
            transport: endpoint.kind,
            assurance,
            endpointOwnerVerified: ownerVerified,
            secretFileGuarded: guardedSecret,
            observedAt,
          });
        }
        if (endpoint.kind === "named-pipe") {
          return Object.freeze({
            transport: endpoint.kind,
            assurance: guardedSecret ? "capability-only" : "unverified",
            // Deliberately the secret's guarantee, not the pipe's: see the file
            // comment. Reporting `true` here on the strength of the pipe alone
            // would claim an OS decision that was never made.
            endpointOwnerVerified: guardedSecret,
            secretFileGuarded: guardedSecret,
            observedAt,
          });
        }
        const peerAddressIsLoopback = isLoopbackAddress(context?.peerAddress);
        return Object.freeze({
          transport: endpoint.kind,
          assurance: guardedSecret ? "capability-only" : "unverified",
          endpointOwnerVerified: guardedSecret,
          secretFileGuarded: guardedSecret,
          peerAddressIsLoopback,
          observedAt,
        });
      } catch {
        return Object.freeze({
          transport: endpoint.kind,
          assurance: "unverified",
          endpointOwnerVerified: false,
          secretFileGuarded: false,
          observedAt,
        });
      }
    },
  };
}
