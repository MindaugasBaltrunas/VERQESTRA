import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuditEvent } from "../application/ports/audit-port.js";
import {
  AppendOnlyAuditFileStore,
  AUDIT_CHAIN_GENESIS_HASH,
} from "../infrastructure/append-only-audit-file-store.js";

function event(index: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: `00000000-0000-4000-8000-00000000000${index}`,
    occurredAt: "2026-07-28T10:00:00.000Z",
    action: "terminal.input",
    outcome: "allowed",
    correlationId: `10000000-0000-4000-8000-00000000000${index}`,
    principalId: "20000000-0000-4000-8000-000000000000",
    deviceId: "30000000-0000-4000-8000-000000000000",
    ...overrides,
  };
}

test("audit records form a verifiable hash chain across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-audit-chain-"));
  const filePath = join(directory, "nested", "audit.jsonl");
  try {
    const store = new AppendOnlyAuditFileStore(filePath);
    assert.deepEqual(await store.verifyChain(), { valid: true, recordCount: 0 });

    for (let index = 1; index <= 3; index += 1) {
      await store.record(event(index));
    }
    const first = await store.verifyChain();
    assert.equal(first.valid, true);
    assert.equal(first.recordCount, 3);

    const records = await store.entries();
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3]);
    assert.equal(records[0]?.previousHash, AUDIT_CHAIN_GENESIS_HASH);
    assert.equal(records[1]?.previousHash, records[0]?.hash);
    assert.equal(records[2]?.previousHash, records[1]?.hash);

    // A restarted gateway continues the same chain instead of forking it.
    const reopened = new AppendOnlyAuditFileStore(filePath);
    await reopened.record(event(4));
    const continued = await reopened.verifyChain();
    assert.equal(continued.valid, true);
    assert.equal(continued.recordCount, 4);
    const all = await reopened.entries();
    assert.equal(all[3]?.previousHash, all[2]?.hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent audit writes stay strictly sequenced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-audit-concurrent-"));
  try {
    const store = new AppendOnlyAuditFileStore(join(directory, "audit.jsonl"));
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.record(event(index % 10))));
    const verification = await store.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.recordCount, 12);
    assert.deepEqual(
      (await store.entries()).map((record) => record.sequence),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editing, deleting or reordering a record breaks the chain at that point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-audit-tamper-"));
  const filePath = join(directory, "audit.jsonl");
  try {
    const store = new AppendOnlyAuditFileStore(filePath);
    for (let index = 1; index <= 4; index += 1) {
      await store.record(event(index));
    }
    const original = (await readFile(filePath, "utf8")).split("\n").filter((line) => line.length > 0);

    // Edit an outcome in place: the record hash no longer matches its content.
    const edited = [...original];
    const parsed = JSON.parse(edited[1] as string) as { event: { outcome: string } };
    parsed.event.outcome = "allowed-but-actually-denied";
    edited[1] = JSON.stringify(parsed);
    await writeFile(filePath, `${edited.join("\n")}\n`, "utf8");
    const tampered = await new AppendOnlyAuditFileStore(filePath).verifyChain();
    assert.equal(tampered.valid, false);
    assert.equal(tampered.brokenAtSequence, 2);
    assert.equal(tampered.reason, "hash_mismatch");

    // Delete a record: the survivors no longer link to their predecessor.
    await writeFile(filePath, `${[original[0], original[2], original[3]].join("\n")}\n`, "utf8");
    const deleted = await new AppendOnlyAuditFileStore(filePath).verifyChain();
    assert.equal(deleted.valid, false);
    assert.equal(deleted.brokenAtSequence, 3);
    assert.equal(deleted.reason, "sequence_gap");

    // Reorder two records: sequence and link both disagree.
    await writeFile(
      filePath,
      `${[original[1], original[0], original[2], original[3]].join("\n")}\n`,
      "utf8",
    );
    const reordered = await new AppendOnlyAuditFileStore(filePath).verifyChain();
    assert.equal(reordered.valid, false);
    assert.equal(reordered.brokenAtSequence, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a persisted audit record still carries no terminal content or credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-audit-content-"));
  const filePath = join(directory, "audit.jsonl");
  try {
    const store = new AppendOnlyAuditFileStore(filePath);
    await store.record(event(1, { outcome: "denied", reasonCode: "stale_terminal_lease" }));
    const raw = await readFile(filePath, "utf8");
    const record = JSON.parse(raw.trim()) as { event: Record<string, unknown> };
    assert.deepEqual(Object.keys(record.event).sort(), [
      "action",
      "correlationId",
      "deviceId",
      "eventId",
      "occurredAt",
      "outcome",
      "principalId",
      "reasonCode",
    ]);
    assert.equal(raw.includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
