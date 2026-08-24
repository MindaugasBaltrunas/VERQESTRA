/**
 * Source of the TLS material the gateway would present.
 *
 * `undefined` is not an error: an unconfigured host is a legitimate, expected
 * state, and it is the state in which no remote listener exists. Reporting it
 * as a failure would invite a caller to "recover" from it.
 */
export type HostCertificateMaterial = Readonly<{
  certificatePem: string;
  privateKeyPem: string;
  /**
   * Operator-facing label for this source, used in diagnostics. Never a
   * filesystem path: bootstrap failures are observable through the remote API,
   * and a host path is layout the phone has no business learning.
   */
  sourceLabel: string;
}>;

export interface HostCertificateSourcePort {
  /** Configured material, or `undefined` when the host has none. */
  load(): Promise<HostCertificateMaterial | undefined>;
}
