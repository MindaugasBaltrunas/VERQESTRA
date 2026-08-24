import { readFile, stat } from "node:fs/promises";
import type {
  HostCertificateMaterial,
  HostCertificateSourcePort,
} from "../application/ports/host-certificate-source-port.js";

/**
 * Host certificate material read from operator-managed files.
 *
 * A missing file is "not configured", never an error: that is the state in
 * which the gateway has no remote listener, and it is reached by doing nothing.
 * The files belong in a host-private gateway directory and must never be
 * committed.
 */

/** Group and other permission bits; any of them set makes the key shared. */
const GROUP_AND_OTHER_BITS = 0o077;

export class FileHostCertificateSource implements HostCertificateSourcePort {
  readonly #certificateFile: string;
  readonly #privateKeyFile: string;
  readonly #sourceLabel: string;

  constructor(
    input: Readonly<{ certificateFile: string; privateKeyFile: string; sourceLabel: string }>,
  ) {
    this.#certificateFile = input.certificateFile;
    this.#privateKeyFile = input.privateKeyFile;
    this.#sourceLabel = input.sourceLabel;
  }

  async load(): Promise<HostCertificateMaterial | undefined> {
    const certificatePem = await this.#readOptional(this.#certificateFile);
    if (certificatePem === undefined) return undefined;
    const privateKeyPem = await this.#readOptional(this.#privateKeyFile);
    if (privateKeyPem === undefined) return undefined;
    await this.#assertPrivateKeyIsOwnerOnly();
    return Object.freeze({ certificatePem, privateKeyPem, sourceLabel: this.#sourceLabel });
  }

  async #readOptional(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return undefined;
    }
  }

  async #assertPrivateKeyIsOwnerOnly(): Promise<void> {
    // Windows reports a synthesised POSIX mode that its ACLs do not back, so
    // the check would pass or fail on a value that means nothing there.
    if (process.platform === "win32") return;
    const info = await stat(this.#privateKeyFile);
    if ((info.mode & GROUP_AND_OTHER_BITS) !== 0) {
      // The label, not the path: this message can reach an operator log that a
      // remote error surface also feeds.
      throw new Error(
        `Private key of host certificate source "${this.#sourceLabel}" is readable beyond its owner`,
      );
    }
  }
}
