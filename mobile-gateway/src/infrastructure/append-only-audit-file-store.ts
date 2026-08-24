import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent, AuditPort } from "../application/ports/audit-port.js";
import {
  defaultAuditLogFile,
  hostDataEnvironment,
  requireHostPlatform,
  type HostDataEnvironment,
} from "./gateway-data-directory.js";

/**
 * Tamper-evident, append-only audit store.
 *
 * `threat-model.md` lists audit integrity as a protected asset. An in-memory
 * sink satisfies the boundary but not the property: it disappears with the
 * process and a host-side edit leaves no trace. Each record therefore carries
 * its position and a hash over (sequence, previousHash, canonical event), so
 * deleting, reordering or editing any record breaks the chain from that point
 * on and {@link AppendOnlyAuditFileStore.verifyChain} names the first bad
 * sequence.
 *
 * This is tamper EVIDENCE, not tamper prevention: an attacker holding the file
 * and the host account can rewrite the whole chain. Preventing that needs an
 * off-host or append-only-media sink and is out of scope for the MVP.
 *
 * The file belongs in the host-private gateway data directory, never in the
 * project tree: {@link AppendOnlyAuditFileStore.inGatewayDataDirectory} resolves
 * that location, and the constructor still accepts an explicit path.
 */

export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

export type AuditChainRecord = Readonly<{
  sequence: number;
  previousHash: string;
  hash: string;
  event: AuditEvent;
}>;

export type AuditChainVerification = Readonly<{
  valid: boolean;
  recordCount: number;
  /** First sequence whose hash, link or ordering is wrong. Absent when valid. */
  brokenAtSequence?: number;
  reason?: "hash_mismatch" | "chain_break" | "sequence_gap" | "malformed_record";
}>;

/** Stable key order so the hash does not depend on JSON property insertion order. */
function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

function recordHash(sequence: number, previousHash: string, event: AuditEvent): string {
  return createHash("sha256")
    .update(`${sequence}\n${previousHash}\n${canonicalJson(event as unknown as Record<string, unknown>)}`)
    .digest("hex");
}

export class AppendOnlyAuditFileStore implements AuditPort {
  /** Serializes writes: every record hashes the one before it. */
  private tail: Promise<{ sequence: number; hash: string }>;

  constructor(readonly filePath: string) {
    this.tail = this.loadTail();
  }

  /**
   * The chain is only evidence if it outlives the checkout it describes, so the
   * default sink is the host-private OS application-data directory — not
   * `AG/logs`, which the AG Loop truncates and rotates.
   */
  static inGatewayDataDirectory(
    environment: HostDataEnvironment = hostDataEnvironment(),
  ): AppendOnlyAuditFileStore {
    return new AppendOnlyAuditFileStore(defaultAuditLogFile(requireHostPlatform(environment)));
  }

  private async loadTail(): Promise<{ sequence: number; hash: string }> {
    const records = await this.entries();
    const last = records[records.length - 1];
    return last
      ? { sequence: last.sequence, hash: last.hash }
      : { sequence: 0, hash: AUDIT_CHAIN_GENESIS_HASH };
  }

  async record(event: AuditEvent): Promise<void> {
    // Chain the write onto the previous one and keep the new tail even if this
    // record fails, so a transient write error cannot fork the chain.
    const next = this.tail.then(async (previous) => {
      const sequence = previous.sequence + 1;
      const hash = recordHash(sequence, previous.hash, event);
      const line = `${JSON.stringify({ sequence, previousHash: previous.hash, hash, event })}\n`;
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      // `mode` applies only when this append creates the file; the chain sits
      // beside the credential state, so it is created just as narrowly.
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600, flag: "a" });
      return { sequence, hash };
    });
    this.tail = next.catch(() => this.loadTail());
    await next;
  }

  async entries(): Promise<readonly AuditChainRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditChainRecord);
  }

  async verifyChain(): Promise<AuditChainVerification> {
    let records: readonly AuditChainRecord[];
    try {
      records = await this.entries();
    } catch {
      return { valid: false, recordCount: 0, reason: "malformed_record" };
    }
    let previousHash = AUDIT_CHAIN_GENESIS_HASH;
    let expectedSequence = 1;
    for (const record of records) {
      if (
        !record ||
        typeof record.sequence !== "number" ||
        typeof record.previousHash !== "string" ||
        typeof record.hash !== "string" ||
        !record.event
      ) {
        return { valid: false, recordCount: records.length, brokenAtSequence: expectedSequence, reason: "malformed_record" };
      }
      if (record.sequence !== expectedSequence) {
        return { valid: false, recordCount: records.length, brokenAtSequence: record.sequence, reason: "sequence_gap" };
      }
      if (record.previousHash !== previousHash) {
        return { valid: false, recordCount: records.length, brokenAtSequence: record.sequence, reason: "chain_break" };
      }
      if (recordHash(record.sequence, record.previousHash, record.event) !== record.hash) {
        return { valid: false, recordCount: records.length, brokenAtSequence: record.sequence, reason: "hash_mismatch" };
      }
      previousHash = record.hash;
      expectedSequence += 1;
    }
    return { valid: true, recordCount: records.length };
  }
}
