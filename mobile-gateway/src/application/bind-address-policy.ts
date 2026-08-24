/**
 * Private-network bind policy.
 *
 * The gateway is a host-local device that a phone reaches over the home or
 * overlay network. Which address it may listen on is a security decision, not a
 * configuration detail, so it is decided here — in a module with no imports, no
 * I/O and no clock — and the socket layer only executes the result.
 */

export type BindAddressClass =
  | "wildcard"
  | "loopback"
  | "link-local"
  | "rfc1918"
  | "carrier-grade-nat"
  | "unique-local"
  | "public"
  | "special-purpose"
  | "malformed"
  | "ambiguous";

export type BindDenialReason =
  | "wildcard_forbidden"
  | "loopback_requires_explicit_opt_in"
  | "link_local_forbidden"
  | "public_address_forbidden"
  | "special_purpose_address_forbidden"
  | "ambiguous_address_form"
  | "malformed_address"
  | "privileged_port_forbidden"
  | "invalid_port";

export type BindAddressFamily = "ipv4" | "ipv6";

/** Classes a listener may actually bind; `loopback` only as an opt-in diagnostic. */
export type AllowedBindAddressClass =
  | "rfc1918"
  | "carrier-grade-nat"
  | "unique-local"
  | "loopback";

export type BindDecision =
  | Readonly<{
      allowed: true;
      address: string;
      port: number;
      family: BindAddressFamily;
      addressClass: AllowedBindAddressClass;
      loopbackDiagnostic: boolean;
    }>
  | Readonly<{
      allowed: false;
      reason: BindDenialReason;
      addressClass: BindAddressClass;
    }>;

/**
 * Address classes that carry real mobile traffic.
 *
 * Carrier-grade NAT space is included because Tailscale and ZeroTier hand out
 * `100.64.0.0/10` addresses: for this gateway that overlay is the private
 * network, and excluding it would push users towards a public bind instead.
 */
export const PRIVATE_BIND_ADDRESS_CLASSES: readonly BindAddressClass[] = Object.freeze([
  "rfc1918",
  "carrier-grade-nat",
  "unique-local",
]);

/**
 * Lowest bindable port. Everything below is privileged on POSIX hosts, and a
 * gateway that spawns agent terminals must never be the reason a user runs the
 * process as root.
 */
export const MIN_BIND_PORT = 1024;
export const MAX_BIND_PORT = 65535;

const DENIAL_BY_CLASS: Readonly<
  Record<Exclude<BindAddressClass, AllowedBindAddressClass>, BindDenialReason>
> = Object.freeze({
  // `0.0.0.0` / `::` accept whatever interface the host acquires later,
  // including a public one the policy never inspected.
  wildcard: "wildcard_forbidden",
  // Link-local addresses are unroutable and interface-scoped: a pairing origin
  // built from one is valid on exactly one segment and silently wrong elsewhere.
  "link-local": "link_local_forbidden",
  public: "public_address_forbidden",
  "special-purpose": "special_purpose_address_forbidden",
  ambiguous: "ambiguous_address_form",
  malformed: "malformed_address",
});

/** Strict dotted-quad: four decimal octets, no leading zeros, no spaces. */
function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    // A leading zero reads as octal in several resolvers, so `010.0.0.1` would
    // mean one address to the policy and another to the host.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets;
}

type Ipv6Parse = Readonly<{ bytes: readonly number[]; embeddedIpv4: boolean }>;

/** Strict textual IPv6 to sixteen bytes; at most one `::` run. */
function parseIpv6(value: string): Ipv6Parse | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const compressed = halves.length === 2;
  const headText = halves[0] ?? "";
  const tailText = compressed ? halves[1] ?? "" : "";
  if (!compressed && headText.length === 0) return undefined;
  let embeddedIpv4 = false;

  const convert = (text: string, endsAddress: boolean): number[] | undefined => {
    if (text.length === 0) return [];
    const groups = text.split(":");
    const bytes: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? "";
      if (endsAddress && index === groups.length - 1 && group.includes(".")) {
        const quad = parseIpv4(group);
        if (!quad) return undefined;
        embeddedIpv4 = true;
        bytes.push(...quad);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      const word = Number.parseInt(group, 16);
      bytes.push((word >> 8) & 0xff, word & 0xff);
    }
    return bytes;
  };

  const head = convert(headText, !compressed);
  if (!head) return undefined;
  const tail = compressed ? convert(tailText, true) : [];
  if (!tail) return undefined;

  if (!compressed) {
    return head.length === 16 ? { bytes: head, embeddedIpv4 } : undefined;
  }
  const zeros = 16 - head.length - tail.length;
  // `::` must stand for at least one omitted group; otherwise the text is a
  // full address written with a decorative compression marker.
  if (zeros < 2) return undefined;
  return {
    bytes: [...head, ...new Array<number>(zeros).fill(0), ...tail],
    embeddedIpv4,
  };
}

function classifyIpv4(octets: readonly number[]): BindAddressClass {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (a === 0 && b === 0 && c === 0 && d === 0) return "wildcard";
  if (a === 0) return "special-purpose";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "rfc1918";
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918";
  if (a === 192 && b === 168) return "rfc1918";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  // Multicast, reserved and the broadcast address all live above 224/4.
  if (a >= 224) return "special-purpose";
  return "public";
}

function classifyIpv6(bytes: readonly number[]): BindAddressClass {
  const [first = 0, second = 0] = bytes;
  if (bytes.every((byte) => byte === 0)) return "wildcard";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "loopback";
  if ((first & 0xfe) === 0xfc) return "unique-local";
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link-local";
  if (first === 0xff) return "special-purpose";
  return "public";
}

export function classifyBindAddress(address: string): BindAddressClass {
  const ipv4 = parseIpv4(address);
  if (ipv4) return classifyIpv4(ipv4);
  if (!address.includes(":")) return "malformed";
  const zoneIndex = address.indexOf("%");
  const parsed = parseIpv6(zoneIndex === -1 ? address : address.slice(0, zoneIndex));
  if (!parsed) return "malformed";
  // A zone identifier or an IPv4-mapped form names one host through a second
  // syntax: the string the policy classified and the string the socket resolves
  // are then not provably the same, so neither is bindable.
  if (zoneIndex !== -1 || parsed.embeddedIpv4) return "ambiguous";
  return classifyIpv6(parsed.bytes);
}

function isAllowedBindAddressClass(value: BindAddressClass): value is AllowedBindAddressClass {
  return (
    value === "rfc1918" ||
    value === "carrier-grade-nat" ||
    value === "unique-local" ||
    value === "loopback"
  );
}

function portDenial(port: number): BindDenialReason | undefined {
  if (!Number.isInteger(port) || port < 0 || port > MAX_BIND_PORT) return "invalid_port";
  if (port < MIN_BIND_PORT) return "privileged_port_forbidden";
  return undefined;
}

/**
 * Decide a bind target. The address is classified first: a caller that supplied
 * both a public address and a privileged port should hear about the address,
 * because that is the exposure, and the port is only how it is reached.
 */
export function evaluateBindTarget(
  input: Readonly<{ address: string; port: number; allowLoopback?: boolean }>,
): BindDecision {
  const addressClass = classifyBindAddress(input.address);
  if (!isAllowedBindAddressClass(addressClass)) {
    return { allowed: false, reason: DENIAL_BY_CLASS[addressClass], addressClass };
  }
  // Loopback carries no mobile traffic; it is useful only for a local
  // diagnostic run, so it must be asked for by name and never inferred.
  if (addressClass === "loopback" && input.allowLoopback !== true) {
    return { allowed: false, reason: "loopback_requires_explicit_opt_in", addressClass };
  }
  const denial = portDenial(input.port);
  if (denial) {
    return { allowed: false, reason: denial, addressClass };
  }
  return {
    allowed: true,
    address: input.address,
    port: input.port,
    family: parseIpv4(input.address) ? "ipv4" : "ipv6",
    addressClass,
    loopbackDiagnostic: addressClass === "loopback",
  };
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Whether a value may be advertised as the pairing origin host.
 *
 * Lowercase only, because the advertised name is compared byte-wise against a
 * certificate SAN, and an IP literal is rejected outright: an address belongs to
 * {@link evaluateBindTarget}, which is the code that decides whether the host is
 * allowed to be reachable there at all.
 */
export function isAdvertisableHostName(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  if (classifyBindAddress(value) !== "malformed") return false;
  return value
    .split(".")
    .every((label) => label.length >= 1 && label.length <= 63 && DNS_LABEL.test(label));
}
