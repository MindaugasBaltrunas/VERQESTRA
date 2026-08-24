import { createHash } from "node:crypto";
import { LocalControlError } from "./local-control-errors.js";
import type {
  LocalControlEndpoint,
  LocalPeerAttestation,
} from "./ports/local-peer-identity-port.js";

/**
 * The decision half of local peer trust.
 *
 * The infrastructure adapter observes the host and reports what it could prove;
 * everything that turns those observations into "may this request run at all"
 * lives here, as pure predicates. Keeping the two apart is what makes the
 * refusals testable without a real socket — and it means a platform that can
 * prove less cannot quietly become a platform that is trusted more.
 *
 * `node:crypto` is the only host module this file may reach for, and only to
 * derive a stable pipe name from a path. No filesystem, no network, no process.
 */

export type LocalPeerPolicy = Readonly<{
  /**
   * Whether an endpoint whose protection is a secret file rather than an OS
   * access-control decision may serve local control. Windows named pipes and the
   * loopback fallback can offer nothing stronger, so a composition that supports
   * them must say so explicitly instead of inheriting the weaker level silently.
   */
  allowCapabilityOnlyAssurance: boolean;
}>;

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

/** Bytes a POSIX `sockaddr_un` path may occupy before the kernel truncates it. */
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

const LOCAL_SOCKET_FILE = "local-control.sock";

/**
 * Refuses a request whose peer could not be established as the local owner.
 *
 * Every clause is a refusal, never a downgrade: there is no path through this
 * function that accepts a weaker proof than the policy allows.
 */
export function assertLocalPeerTrusted(
  attestation: LocalPeerAttestation,
  policy: LocalPeerPolicy,
): void {
  if (attestation.assurance === "unverified") {
    throw new LocalControlError("forbidden", "Local peer identity could not be established");
  }
  if (!attestation.endpointOwnerVerified) {
    throw new LocalControlError("forbidden", "Local control endpoint is not owner-restricted");
  }
  if (!attestation.secretFileGuarded) {
    throw new LocalControlError("forbidden", "Local control secret file is not owner-only");
  }
  if (attestation.assurance === "capability-only" && !policy.allowCapabilityOnlyAssurance) {
    throw new LocalControlError(
      "forbidden",
      "Local control requires an OS-verified peer on this host",
    );
  }
  if (attestation.transport === "loopback-http" && attestation.peerAddressIsLoopback !== true) {
    throw new LocalControlError("forbidden", "Local control accepts loopback peers only");
  }
}

/**
 * Refuses a loopback request that was addressed to anything but this listener.
 *
 * A `Host` header naming another name is how a browser page or a DNS-rebinding
 * answer reaches a loopback port from outside the host's own tooling. The port
 * must match exactly — the default-port spellings (`localhost` with no port) are
 * refused because this listener never binds 80 or 443.
 */
export function assertLoopbackHost(hostHeader: string | undefined, expectedPort: number): void {
  if (hostHeader === undefined) {
    throw new LocalControlError("forbidden", "Host header is required on the loopback listener");
  }
  const separator = hostHeader.lastIndexOf(":");
  const host = separator === -1 ? hostHeader : hostHeader.slice(0, separator);
  const port = separator === -1 ? "" : hostHeader.slice(separator + 1);
  if (!LOOPBACK_HOSTS.includes(host.toLowerCase()) || port !== String(expectedPort)) {
    throw new LocalControlError("forbidden", "Host header does not address the local listener");
  }
}

/**
 * Where the local channel should listen on this host.
 *
 * The loopback fallback is returned only when a composition passes one. A
 * listener that silently degraded from an OS-protected socket to a TCP port
 * would move the boundary without anyone deciding to.
 *
 * Paths are joined with `/` rather than `node:path` so this file stays free of
 * host modules; the POSIX socket path is the only one assembled here, and the
 * Windows pipe name is not a filesystem path at all.
 */
export function resolveLocalControlEndpoint(
  input: Readonly<{
    platform: NodeJS.Platform;
    dataDirectory: string;
    runtimeDirectory?: string;
    loopbackFallback?: Readonly<{ address: string; port: number }>;
  }>,
): LocalControlEndpoint {
  if (input.loopbackFallback) {
    return Object.freeze({
      kind: "loopback-http" as const,
      address: input.loopbackFallback.address,
      port: input.loopbackFallback.port,
    });
  }
  if (input.platform === "win32") {
    // A pipe name is global to the host, so it is derived from the data
    // directory: two gateways with separate state never collide, and the name
    // still leaks nothing about where that state lives.
    const suffix = createHash("sha256").update(input.dataDirectory, "utf8").digest("hex").slice(0, 16);
    return Object.freeze({
      kind: "named-pipe" as const,
      path: `${String.raw`\\.\pipe\ag-mobile-gateway-local-`}${suffix}`,
    });
  }
  const directory = input.runtimeDirectory ?? input.dataDirectory;
  const path = `${directory.endsWith("/") ? directory.slice(0, -1) : directory}/${LOCAL_SOCKET_FILE}`;
  if (Buffer.byteLength(path, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    // Silent truncation by the kernel would bind a DIFFERENT path than the one
    // whose ownership the attestation checked.
    throw new LocalControlError(
      "internal_error",
      `Local control socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes`,
    );
  }
  return Object.freeze({ kind: "unix-socket" as const, path });
}
