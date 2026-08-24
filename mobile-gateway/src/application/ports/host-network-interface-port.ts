export type HostNetworkAddress = Readonly<{
  address: string;
  family: "ipv4" | "ipv6";
  interfaceName: string;
  /** Host-internal (loopback) addresses, as reported by the operating system. */
  internal: boolean;
}>;

/**
 * Read-only view of the host's own addresses.
 *
 * Like {@link ProcessIdentityPort}, this port can only observe: it exposes no
 * bind, attach or configure operation, so bootstrap can prove that a requested
 * address really belongs to this host without gaining the ability to change the
 * host's networking.
 */
export interface HostNetworkInterfacePort {
  addresses(): Promise<readonly HostNetworkAddress[]>;
}
