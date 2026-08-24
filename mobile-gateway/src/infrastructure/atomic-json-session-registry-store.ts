import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  SessionRegistryStorePort,
  SessionRegistryUpdate,
} from "../application/ports/session-registry-store-port.js";
import type { SessionRegistrySnapshot } from "../domain/session-registry.js";
import {
  defaultSessionRegistryFile,
  hostDataEnvironment,
  requireHostPlatform,
  type HostDataEnvironment,
} from "./gateway-data-directory.js";

/**
 * Atomic, integrity-checked session registry file.
 *
 * `runtime-state-machines.md` requires the registry to load "with an integrity
 * checksum and monotonically increasing revision". Both are enforced on read:
 * a checksum mismatch or a revision that moved backwards fails CLOSED rather
 * than reconciling against a corrupted or rolled-back file — reattaching a live
 * PTY from an untrustworthy record is worse than treating every session as
 * orphaned.
 *
 * The file belongs in the host-private gateway data directory, never in the
 * project tree.
 */

export class SessionRegistryIntegrityError extends Error {
  constructor(readonly reason: "checksum_mismatch" | "revision_rollback" | "malformed") {
    super(`Session registry failed its integrity check: ${reason}`);
    this.name = "SessionRegistryIntegrityError";
  }
}

type RegistryFile = {
  checksum: string;
  snapshot: SessionRegistrySnapshot;
};

/** Stable key order so the checksum does not depend on property insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function checksumOf(snapshot: SessionRegistrySnapshot): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(snapshot))).digest("hex");
}

function emptySnapshot(gatewayInstanceId: string): SessionRegistrySnapshot {
  return { version: 1, revision: 1, gatewayInstanceId, sessions: {}, worktrees: {} };
}

export class AtomicJsonSessionRegistryStore implements SessionRegistryStorePort {
  private queue: Promise<void> = Promise.resolve();
  private snapshot: SessionRegistrySnapshot | undefined;
  readonly registryFile: string;

  constructor(registryFile: string, private readonly gatewayInstanceId: string) {
    this.registryFile = resolve(registryFile);
  }

  /**
   * The registry survives a gateway restart, so it belongs to the host account
   * rather than to a checkout: the OS application-data directory, never the
   * project tree that the AG Loop rewrites and rolls back.
   */
  static inGatewayDataDirectory(
    gatewayInstanceId: string,
    environment: HostDataEnvironment = hostDataEnvironment(),
  ): AtomicJsonSessionRegistryStore {
    return new AtomicJsonSessionRegistryStore(
      defaultSessionRegistryFile(requireHostPlatform(environment)),
      gatewayInstanceId,
    );
  }

  private async load(): Promise<SessionRegistrySnapshot> {
    if (this.snapshot) {
      return this.snapshot;
    }
    await mkdir(dirname(this.registryFile), { recursive: true, mode: 0o700 });
    let contents: string;
    try {
      contents = await readFile(this.registryFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const created = emptySnapshot(this.gatewayInstanceId);
      await this.persist(created);
      this.snapshot = created;
      return created;
    }

    let parsed: RegistryFile;
    try {
      parsed = JSON.parse(contents) as RegistryFile;
    } catch {
      throw new SessionRegistryIntegrityError("malformed");
    }
    if (
      !parsed?.snapshot ||
      parsed.snapshot.version !== 1 ||
      typeof parsed.checksum !== "string" ||
      !Number.isSafeInteger(parsed.snapshot.revision) ||
      parsed.snapshot.revision < 1 ||
      typeof parsed.snapshot.sessions !== "object"
    ) {
      throw new SessionRegistryIntegrityError("malformed");
    }
    if (checksumOf(parsed.snapshot) !== parsed.checksum) {
      throw new SessionRegistryIntegrityError("checksum_mismatch");
    }
    // Tolerate a registry written before worktree disposition was tracked; the
    // checksum was computed over what was actually stored, so defaulting here
    // must happen after verification.
    this.snapshot = { ...parsed.snapshot, worktrees: parsed.snapshot.worktrees ?? {} };
    return this.snapshot;
  }

  private async persist(snapshot: SessionRegistrySnapshot): Promise<void> {
    const file: RegistryFile = { checksum: checksumOf(snapshot), snapshot };
    const temporary = `${this.registryFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.registryFile);
  }

  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = (): void => undefined;
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async read(): Promise<SessionRegistrySnapshot> {
    return this.exclusively(async () => structuredClone(await this.load()));
  }

  async update<T>(
    mutate: (current: SessionRegistrySnapshot) => SessionRegistryUpdate<T>,
  ): Promise<T> {
    return this.exclusively(async () => {
      const current = await this.load();
      const updated = mutate(structuredClone(current));
      if (updated.snapshot.revision <= current.revision) {
        throw new SessionRegistryIntegrityError("revision_rollback");
      }
      await this.persist(updated.snapshot);
      this.snapshot = updated.snapshot;
      return updated.result;
    });
  }
}
