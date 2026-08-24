import assert from "node:assert/strict";
import {
  HostBootstrap,
  HostBootstrapError,
  type HostBootstrapFailureCode,
} from "../application/host-bootstrap.js";
import type {
  GatewayListenerHandle,
  GatewayListenerPort,
  GatewayListenRequest,
} from "../application/ports/gateway-listener-port.js";
import type {
  HostCertificateMaterial,
  HostCertificateSourcePort,
} from "../application/ports/host-certificate-source-port.js";
import type {
  HostNetworkAddress,
  HostNetworkInterfacePort,
} from "../application/ports/host-network-interface-port.js";
import { createTestCertificate } from "./x509-test-certificate.js";

/**
 * Shared doubles for the host bootstrap suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `host-bootstrap.test.ts` buvo 618 eilučių).
 * Fikstūra iškelta į atskirą modulį — ta pati konvencija kaip `local-control-doubles.ts` — kad
 * `host-bootstrap.test.ts` (tapatybės atmetimai) ir `host-bootstrap-binding.test.ts` (bind
 * politika ir gyvavimo ciklas) dalintųsi VIENU sprendimu, ką reiškia „hostas be lizdo".
 * Dvi kopijos būtų išsiskyrusios tyliai, o būtent šios fikstūros `assertFailsClosed` yra
 * tai, kas paverčia „fail-closed" tikrinamu, o ne deklaruojamu.
 */

export const NOW = new Date("2026-08-05T12:00:00.000Z");
export const NOT_BEFORE = new Date("2026-01-01T00:00:00.000Z");
export const NOT_AFTER = new Date("2027-01-01T00:00:00.000Z");
export const BIND_ADDRESS = "10.0.0.5";
export const BIND_PORT = 8443;

export type TestCertificate = ReturnType<typeof createTestCertificate>;

export function hostCertificate(
  overrides: Partial<Parameters<typeof createTestCertificate>[0]> = {},
): TestCertificate {
  return createTestCertificate({
    commonName: "ag-host",
    ipSans: [BIND_ADDRESS],
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
    ...overrides,
  });
}

export function material(certificate: TestCertificate): HostCertificateMaterial {
  return {
    certificatePem: certificate.certificatePem,
    privateKeyPem: certificate.privateKeyPem,
    sourceLabel: "test host certificate source",
  };
}

export function assigned(
  address: string,
  family: "ipv4" | "ipv6",
  internal = false,
): HostNetworkAddress {
  return { address, family, interfaceName: internal ? "lo0" : "en0", internal };
}

export class SpyGatewayListener implements GatewayListenerPort {
  startCalls = 0;
  closeCalls = 0;
  readonly requests: GatewayListenRequest[] = [];
  failure?: Error;

  async start(request: GatewayListenRequest): Promise<GatewayListenerHandle> {
    this.startCalls += 1;
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return {
      address: request.address,
      port: request.port,
      close: async (): Promise<void> => {
        this.closeCalls += 1;
      },
    };
  }
}

export function certificateSource(
  load: () => Promise<HostCertificateMaterial | undefined>,
): HostCertificateSourcePort {
  return { load };
}

export function interfaceSource(
  addresses: readonly HostNetworkAddress[],
): HostNetworkInterfacePort {
  return { addresses: async () => addresses };
}

export type Fixture = Readonly<{ bootstrap: HostBootstrap; listener: SpyGatewayListener }>;

export function fixture(
  input: Readonly<{
    certificates?: HostCertificateSourcePort;
    interfaces?: HostNetworkInterfacePort;
    listenerFailure?: Error;
  }> = {},
): Fixture {
  const listener = new SpyGatewayListener();
  if (input.listenerFailure) listener.failure = input.listenerFailure;
  const bootstrap = new HostBootstrap({
    certificates:
      input.certificates ?? certificateSource(async () => material(hostCertificate())),
    interfaces: input.interfaces ?? interfaceSource([assigned(BIND_ADDRESS, "ipv4")]),
    listener,
  });
  return { bootstrap, listener };
}

/** Assert the failure code and that the gateway fell back to having no socket. */
export async function assertFailsClosed(
  active: Fixture,
  operation: Promise<unknown>,
  code: HostBootstrapFailureCode,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof HostBootstrapError && error.code === code,
    code,
  );
  assert.equal(active.listener.startCalls, 0, `${code} must not open a socket`);
  const status = active.bootstrap.status();
  assert.equal(status.state, "not_configured", code);
  assert.equal(status.state === "not_configured" && status.lastFailure, code);
}
