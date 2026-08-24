/**
 * The host-private secret every local control request is proved against.
 *
 * Possession of this secret is the local channel's second factor: the transport
 * establishes WHO connected, the secret establishes that the caller is a program
 * the owner actually granted local control to. It never leaves the host and is
 * never a device credential, so it has no rotation protocol here — the file is
 * the boundary, and {@link LocalControlSecret.fileGuarded} reports whether that
 * boundary held.
 */

export type LocalControlSecret = Readonly<{
  secret: Uint8Array;
  /** The secret file is a regular, owner-only file of the expected size. */
  fileGuarded: boolean;
}>;

export interface LocalControlSecretPort {
  load(): Promise<LocalControlSecret>;
}
