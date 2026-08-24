import { networkInterfaces } from "node:os";
import type {
  HostNetworkAddress,
  HostNetworkInterfacePort,
} from "../application/ports/host-network-interface-port.js";

/**
 * The host's own addresses, normalized to the shape the bind policy compares
 * against: lowercase family names and no IPv6 zone suffix, so an interface
 * entry and a requested address differ only where they really differ.
 */
export class OsHostNetworkInterfaces implements HostNetworkInterfacePort {
  async addresses(): Promise<readonly HostNetworkAddress[]> {
    const collected: HostNetworkAddress[] = [];
    for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        const zoneIndex = entry.address.indexOf("%");
        collected.push({
          address: zoneIndex === -1 ? entry.address : entry.address.slice(0, zoneIndex),
          family: entry.family === "IPv6" ? "ipv6" : "ipv4",
          interfaceName,
          internal: entry.internal,
        });
      }
    }
    return collected;
  }
}
