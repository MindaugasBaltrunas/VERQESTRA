/**
 * Who the local control channel is actually talking to.
 *
 * `local-control-contract.md` makes the local surface reachable "only to the
 * authenticated local OS user". That claim rests on facts only the host can
 * establish — endpoint ownership, file modes, the peer address of a loopback
 * socket — so the application layer never inspects them itself. It receives a
 * {@link LocalPeerAttestation}: a closed record of what the transport was able
 * to PROVE, together with how strong that proof is.
 *
 * The assurance level is explicit rather than boolean because the platforms
 * differ in what they can prove. A Unix-domain socket in an owner-only
 * directory is an OS access-control decision; a Windows named pipe is not, and
 * pretending otherwise would hide a real weakening of the boundary behind a
 * flag that reads the same on both.
 *
 * {@link LocalControlEndpoint} is declared here, at the identity boundary, so
 * the listener port can depend on it without the two ports depending on each
 * other.
 */

export type LocalControlTransportKind = "named-pipe" | "unix-socket" | "loopback-http";

/** Where the local channel listens; never a phone-facing address. */
export type LocalControlEndpoint = Readonly<
  | { kind: "named-pipe" | "unix-socket"; path: string }
  | { kind: "loopback-http"; address: string; port: number }
>;

/**
 * How strongly the peer's identity was established:
 * - `os-acl-verified` — the operating system itself refused every other user;
 * - `capability-only` — access is bounded by possession of an owner-only
 *   secret, not by an OS access-control decision;
 * - `unverified` — nothing could be established, which is always a refusal.
 */
export type LocalPeerAssurance = "os-acl-verified" | "capability-only" | "unverified";

export type LocalPeerAttestation = Readonly<{
  transport: LocalControlTransportKind;
  assurance: LocalPeerAssurance;
  /** Endpoint (socket/pipe/secret file) is owned by the gateway's OS user and unreachable by group/other. */
  endpointOwnerVerified: boolean;
  /** Secret file exists with owner-only mode and is a regular file, not a link. */
  secretFileGuarded: boolean;
  /** Loopback fallback only: peer address is a loopback literal. */
  peerAddressIsLoopback?: boolean;
  observedAt: string;
}>;

/** Transport-supplied facts an attestation cannot derive from the endpoint alone. */
export type LocalPeerContext = Readonly<{
  /** Remote address of the accepted connection, as the kernel reported it. */
  peerAddress?: string;
}>;

export interface LocalPeerIdentityPort {
  attest(endpoint: LocalControlEndpoint, context?: LocalPeerContext): Promise<LocalPeerAttestation>;
}
