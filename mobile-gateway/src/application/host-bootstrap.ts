import {
  evaluateBindTarget,
  type AllowedBindAddressClass,
  type BindDenialReason,
} from "./bind-address-policy.js";
import {
  HostCertificateError,
  inspectHostCertificate,
  type HostCertificateErrorCode,
  type HostCertificateIdentity,
} from "./host-identity.js";
import type { GatewayListenerHandle, GatewayListenerPort } from "./ports/gateway-listener-port.js";
import type {
  HostCertificateMaterial,
  HostCertificateSourcePort,
} from "./ports/host-certificate-source-port.js";
import type {
  HostNetworkAddress,
  HostNetworkInterfacePort,
} from "./ports/host-network-interface-port.js";

/**
 * Host bootstrap.
 *
 * A remote listener exists only when a provable host identity, an allowed
 * private-network bind target and a host-assigned address all hold at the same
 * time. There is no degraded mode: no plain HTTP, no self-signed fallback, no
 * "listening but unverified". Every failure returns to `not_configured`, so the
 * only way to reach a socket is through a complete, successful configuration.
 */

export type HostBootstrapState =
  | "not_configured"
  | "configuring"
  | "ready"
  | "listening"
  /**
   * Declared for the transition graph. It is never observed: `stop()` releases
   * the socket and the identity together, which leaves nothing that
   * distinguishes a stopped host from an unconfigured one.
   */
  | "stopped";

export type HostBootstrapFailureCode =
  | HostCertificateErrorCode
  | BindDenialReason
  | "bind_address_not_assigned"
  | "interface_enumeration_failed"
  | "listener_start_failed"
  | "already_listening"
  | "not_configured";

export class HostBootstrapError extends Error {
  readonly code: HostBootstrapFailureCode;

  constructor(code: HostBootstrapFailureCode, message: string) {
    super(message);
    this.name = "HostBootstrapError";
    this.code = code;
  }
}

export type ResolvedHostBinding = Readonly<{
  identity: HostCertificateIdentity;
  address: string;
  port: number;
  family: "ipv4" | "ipv6";
  addressClass: AllowedBindAddressClass;
  loopbackDiagnostic: boolean;
  /** Origin the pairing code advertises, e.g. `https://[fd12::1]:8443`. */
  pairingOrigin: string;
}>;

export type HostBootstrapStatus =
  | Readonly<{ state: "not_configured" | "stopped"; lastFailure?: HostBootstrapFailureCode }>
  | Readonly<{ state: "configuring" }>
  | Readonly<{ state: "ready" | "listening"; binding: ResolvedHostBinding }>;

export type HostBindRequest = Readonly<{
  address: string;
  port: number;
  advertisedHost?: string;
  allowLoopback?: boolean;
  now?: Date;
}>;

/** Case-insensitive, zone-free form used to compare two spellings of one address. */
function normalizeAddress(value: string): string {
  const zoneIndex = value.indexOf("%");
  return (zoneIndex === -1 ? value : value.slice(0, zoneIndex)).trim().toLowerCase();
}

function pairingOriginOf(
  address: string,
  port: number,
  family: "ipv4" | "ipv6",
  advertisedHost: string | undefined,
): string {
  if (advertisedHost !== undefined) return `https://${advertisedHost}:${port}`;
  return family === "ipv6" ? `https://[${address}]:${port}` : `https://${address}:${port}`;
}

export class HostBootstrap {
  readonly #certificates: HostCertificateSourcePort;
  readonly #interfaces: HostNetworkInterfacePort;
  readonly #listener: GatewayListenerPort;
  #state: HostBootstrapState = "not_configured";
  // `exactOptionalPropertyTypes`: šie laukai VISADA egzistuoja ir yra nunulinami (`= undefined`)
  // kiekviename gedimo kelyje, tad jie deklaruojami `| undefined`, o ne `?`. Etalone jie buvo
  // opcionalūs, bet ten opcionalumas ir „reikšmė yra undefined" nebuvo atskiriami; čia atskiriami,
  // ir teisingas iš dviejų yra šis — laukas niekada nedingsta, tik ištuštėja.
  #lastFailure: HostBootstrapFailureCode | undefined;
  #binding: ResolvedHostBinding | undefined;
  #handle: GatewayListenerHandle | undefined;

  constructor(
    dependencies: Readonly<{
      certificates: HostCertificateSourcePort;
      interfaces: HostNetworkInterfacePort;
      listener: GatewayListenerPort;
    }>,
  ) {
    this.#certificates = dependencies.certificates;
    this.#interfaces = dependencies.interfaces;
    this.#listener = dependencies.listener;
  }

  status(): HostBootstrapStatus {
    if (this.#state === "configuring") return { state: "configuring" };
    const binding = this.#binding;
    if ((this.#state === "ready" || this.#state === "listening") && binding) {
      return { state: this.#state, binding };
    }
    return this.#lastFailure === undefined
      ? { state: "not_configured" }
      : { state: "not_configured", lastFailure: this.#lastFailure };
  }

  /**
   * Prove the host identity and the bind target, in that order. All four steps
   * — certificate material, certificate inspection, bind policy and host
   * address assignment — must pass; any one of them returns the gateway to
   * `not_configured` and throws.
   */
  async configure(request: HostBindRequest): Promise<ResolvedHostBinding> {
    if (this.#state === "listening") {
      // Reconfiguring under a live socket would leave the listener bound to a
      // target the current identity no longer describes.
      throw new HostBootstrapError(
        "already_listening",
        "Stop the gateway listener before reconfiguring the host binding",
      );
    }
    this.#state = "configuring";
    this.#binding = undefined;
    this.#lastFailure = undefined;

    const material = await this.#loadMaterial();
    let identity: HostCertificateIdentity;
    try {
      // `exactOptionalPropertyTypes`: neperduoto lauko ir lauko su `undefined` sulieti negalima.
      // Sąlyginiai spread'ai išlaiko etalono prasmę — „nenurodyta" reiškia NEBUVIMĄ, o
      // `inspectHostCertificate` būtent iš to sprendžia, tikrinti IP SAN ar DNS SAN.
      identity = inspectHostCertificate({
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
        bindAddress: request.address,
        ...(request.advertisedHost === undefined ? {} : { advertisedHost: request.advertisedHost }),
        ...(request.now === undefined ? {} : { now: request.now }),
      });
    } catch (error) {
      const code =
        error instanceof HostCertificateError ? error.code : ("certificate_unparsable" as const);
      throw this.#failed(code, `Host certificate from ${material.sourceLabel} was rejected`);
    }

    const decision = evaluateBindTarget({
      address: request.address,
      port: request.port,
      ...(request.allowLoopback === undefined ? {} : { allowLoopback: request.allowLoopback }),
    });
    if (!decision.allowed) {
      throw this.#failed(
        decision.reason,
        `Bind target rejected as ${decision.addressClass}: ${decision.reason}`,
      );
    }

    let addresses: readonly HostNetworkAddress[];
    try {
      addresses = await this.#interfaces.addresses();
    } catch {
      throw this.#failed(
        "interface_enumeration_failed",
        "Host network interfaces could not be enumerated",
      );
    }
    // The address must be one this host already holds, and on the side of the
    // internal/external divide the policy decided: a diagnostic loopback run
    // must not be satisfied by a real network interface, and vice versa.
    const wanted = normalizeAddress(decision.address);
    const assigned = addresses.some(
      (candidate) =>
        normalizeAddress(candidate.address) === wanted &&
        candidate.internal === decision.loopbackDiagnostic,
    );
    if (!assigned) {
      throw this.#failed(
        "bind_address_not_assigned",
        "Requested bind address is not assigned to a matching host interface",
      );
    }

    const binding: ResolvedHostBinding = Object.freeze({
      identity,
      address: decision.address,
      port: decision.port,
      family: decision.family,
      addressClass: decision.addressClass,
      loopbackDiagnostic: decision.loopbackDiagnostic,
      pairingOrigin: pairingOriginOf(
        decision.address,
        decision.port,
        decision.family,
        request.advertisedHost,
      ),
    });
    this.#binding = binding;
    this.#state = "ready";
    return binding;
  }

  async start(): Promise<ResolvedHostBinding> {
    const binding = this.#binding;
    if (this.#state === "listening" && binding) {
      // Not a reset: the running listener is still the configured one.
      throw new HostBootstrapError("already_listening", "Gateway listener is already started");
    }
    if (this.#state !== "ready" || !binding) {
      throw this.#failed("not_configured", "Gateway listener requires a configured host binding");
    }
    try {
      this.#handle = await this.#listener.start({
        address: binding.address,
        port: binding.port,
        family: binding.family,
      });
    } catch {
      throw this.#failed("listener_start_failed", "Gateway listener refused the approved binding");
    }
    this.#state = "listening";
    return binding;
  }

  async stop(): Promise<void> {
    if (this.#state !== "listening") return;
    const handle = this.#handle;
    // State is dropped before the await so a concurrent `stop()` cannot close
    // the same handle twice; a rejecting close then surfaces on a gateway that
    // already holds no identity, which is the fail-closed side.
    this.#handle = undefined;
    this.#binding = undefined;
    this.#lastFailure = undefined;
    this.#state = "not_configured";
    if (handle) await handle.close();
  }

  hostFingerprint(): string {
    return this.identity().hostFingerprint;
  }

  identity(): HostCertificateIdentity {
    const binding = this.#binding;
    if ((this.#state !== "ready" && this.#state !== "listening") || !binding) {
      throw new HostBootstrapError(
        "not_configured",
        "Host identity is available only after a successful bootstrap",
      );
    }
    return binding.identity;
  }

  async #loadMaterial(): Promise<HostCertificateMaterial> {
    let material: HostCertificateMaterial | undefined;
    try {
      material = await this.#certificates.load();
    } catch {
      // A source that cannot be read and a source that holds nothing are the
      // same fact for this caller: there is no usable certificate. The
      // underlying message is deliberately dropped — it can carry host paths.
      throw this.#failed("certificate_missing", "Host certificate source could not be read");
    }
    if (!material) {
      throw this.#failed("certificate_missing", "No host certificate is configured");
    }
    return material;
  }

  /** Return the gateway to its only post-failure state and build the error to throw. */
  #failed(code: HostBootstrapFailureCode, message: string): HostBootstrapError {
    this.#state = "not_configured";
    this.#binding = undefined;
    this.#handle = undefined;
    this.#lastFailure = code;
    return new HostBootstrapError(code, message);
  }
}
