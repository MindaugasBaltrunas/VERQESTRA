import type { SessionRegistrySnapshot } from "../../domain/session-registry.js";

export type SessionRegistryUpdate<T> = Readonly<{
  snapshot: SessionRegistrySnapshot;
  result: T;
}>;

/**
 * Durable home of the terminal session registry.
 *
 * The store owns integrity (checksum), monotonic revision and atomic
 * replacement; callers only describe the next snapshot. It belongs in the
 * host-private gateway data directory — never `AG/state` or the project tree.
 */
export interface SessionRegistryStorePort {
  read(): Promise<SessionRegistrySnapshot>;
  update<T>(mutate: (current: SessionRegistrySnapshot) => SessionRegistryUpdate<T>): Promise<T>;
}
