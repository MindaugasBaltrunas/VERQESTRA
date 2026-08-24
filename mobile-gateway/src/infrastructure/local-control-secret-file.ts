import { randomBytes } from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import { LocalControlError } from "../application/local-control-errors.js";
import type {
  LocalControlSecret,
  LocalControlSecretPort,
} from "../application/ports/local-control-secret-port.js";

/**
 * The host-private local control secret, kept in one owner-only file.
 *
 * Creation is `wx` with mode `0600` so the file is either created by this
 * gateway or already exists — there is no branch that truncates or overwrites a
 * secret another process may be relying on, and no window in which the file
 * exists with wider permissions than intended.
 *
 * An existing file is validated before it is trusted: a symbolic link, a wrong
 * size or group/other permissions mean the value cannot be assumed private, and
 * the gateway refuses instead of quietly reusing it. Windows carries no usable
 * mode bits, so the mode check is skipped there and the file's protection is
 * whatever the profile directory's ACL provides.
 *
 * The validation is bound to the bytes it admits: the path is `lstat`ed to
 * refuse a link or reparse point, and then opened ONCE, with ownership, mode and
 * size taken from the open descriptor and the bytes read from that same
 * descriptor. Checking a path and then re-opening it leaves a window in which
 * the name can be repointed between the two, which is precisely how a guarded
 * check ends up admitting an unguarded file.
 */

const SECRET_BYTES = 32;
const OWNER_ONLY_MASK = 0o077;
const OWNER_ONLY_MODE = 0o600;

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function createLocalControlSecretFile(path: string): LocalControlSecretPort {
  let cached: Promise<LocalControlSecret> | undefined;

  function refuse(): never {
    // One message for every rejection: the caller learns that the file is not
    // trustworthy, not which property of it gave that away.
    throw new LocalControlError(
      "internal_error",
      "Local control secret file is not a private, owner-only file",
    );
  }

  /** Reads an existing secret, refusing anything it cannot prove is owner-only. */
  async function readGuarded(): Promise<Uint8Array> {
    const link = await lstat(path);
    if (!link.isFile()) {
      // A symbolic link, a junction/reparse point or a directory: whatever it
      // points at, the name is not a file this gateway created.
      refuse();
    }
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      const uid = ownerUid();
      if (
        !stats.isFile() ||
        stats.size !== SECRET_BYTES ||
        (uid !== undefined && (stats.uid !== uid || (stats.mode & OWNER_ONLY_MASK) !== 0))
      ) {
        refuse();
      }
      const buffer = Buffer.alloc(SECRET_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SECRET_BYTES, 0);
      if (bytesRead !== SECRET_BYTES) {
        refuse();
      }
      return new Uint8Array(buffer);
    } finally {
      await handle.close();
    }
  }

  async function load(): Promise<LocalControlSecret> {
    const secret = randomBytes(SECRET_BYTES);
    try {
      await writeFile(path, secret, { flag: "wx", mode: OWNER_ONLY_MODE });
      return Object.freeze({ secret: new Uint8Array(secret), fileGuarded: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new LocalControlError("internal_error", "Local control secret file could not be created");
      }
    }
    try {
      return Object.freeze({ secret: await readGuarded(), fileGuarded: true });
    } catch (error) {
      // A raw `fs` failure carries the absolute path in its message, which
      // `threat-model.md` keeps out of errors and logs alike.
      if (error instanceof LocalControlError) throw error;
      throw new LocalControlError("internal_error", "Local control secret file could not be read");
    }
  }

  return {
    async load(): Promise<LocalControlSecret> {
      // Cached for the process lifetime: the secret is read on every local
      // request, and re-reading it would turn each one into filesystem I/O
      // whose failure mode is a refusal of a legitimate operator action.
      cached ??= load().catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
      return cached;
    },
  };
}
