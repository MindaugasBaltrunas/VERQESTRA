import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalControlError } from "../application/local-control-errors.js";
import type { SessionGateEvidence } from "../application/ports/session-gate-evidence-port.js";
import {
  createFileSessionGateEvidenceRecorder,
  createFileSessionGateEvidenceStore,
} from "../infrastructure/file-session-gate-evidence-store.js";
import { createLocalControlSecretFile } from "../infrastructure/local-control-secret-file.js";
import { createOsLocalPeerIdentity } from "../infrastructure/os-local-peer-identity.js";

/**
 * The host adapters the local channel's trust rests on.
 *
 * They are the only place where a claim in `local-control-contract.md` becomes a
 * filesystem or process fact, so each test asks the same question in a different
 * form: what does this adapter do when it CANNOT prove what it is supposed to
 * report? The answer must always be the closed one — no secret, no assurance, no
 * evidence, and for the gate runner no environment the child did not need.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 513 eilučių): vartų
 * PALEIDĖJAS persikėlė į `local-gate-command-runner.test.ts`. Pjūvis prasmingas: visi šio failo
 * adapteriai atsako „ką hostas gali ĮRODYTI" ir liečia tik failų sistemą, o paleidėjas
 * vienintelis kuria OS procesą — kitas rizikos profilis ir kita fikstūra.
 */

const SECRET_BYTES = 32;
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174010";
const COMMIT = "a".repeat(40);
const RECORDED_AT = "2026-08-09T10:00:00.000Z";

/** Mode bits only exist where `process.getuid` does. */
const posix = typeof process.getuid === "function";

async function directory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function isLocalControlError(error: unknown): boolean {
  return error instanceof LocalControlError && error.code === "internal_error";
}

test("the secret file is created owner-only and reused byte for byte", async () => {
  const root = await directory("ag-local-secret-");
  try {
    const path = join(root, "local-control.secret");
    const created = await createLocalControlSecretFile(path).load();
    assert.equal(created.fileGuarded, true);
    assert.equal(created.secret.byteLength, SECRET_BYTES);

    const stats = await lstat(path);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.size, SECRET_BYTES);
    if (posix) {
      assert.equal(stats.mode & 0o777, 0o600);
    }

    // A second process on the same host must find the same secret, not mint one.
    const reopened = await createLocalControlSecretFile(path).load();
    assert.deepEqual([...reopened.secret], [...created.secret]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a secret file the gateway cannot prove is private is refused", async () => {
  const root = await directory("ag-local-secret-guard-");
  try {
    const wrongSize = join(root, "short.secret");
    await writeFile(wrongSize, Buffer.alloc(16), { mode: 0o600 });
    await assert.rejects(createLocalControlSecretFile(wrongSize).load(), isLocalControlError);

    const asDirectory = join(root, "directory.secret");
    await mkdir(asDirectory);
    await assert.rejects(createLocalControlSecretFile(asDirectory).load(), isLocalControlError);

    if (posix) {
      const groupReadable = join(root, "loose.secret");
      await writeFile(groupReadable, Buffer.alloc(SECRET_BYTES), { mode: 0o600 });
      await chmod(groupReadable, 0o644);
      await assert.rejects(createLocalControlSecretFile(groupReadable).load(), isLocalControlError);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a secret file failure names no path and carries no bytes", async () => {
  const root = await directory("ag-local-secret-error-");
  try {
    const path = join(root, "nested", "missing", "local-control.secret");
    await assert.rejects(createLocalControlSecretFile(path).load(), (error: unknown) => {
      assert.ok(error instanceof LocalControlError);
      assert.equal(error.message.includes(root), false);
      assert.equal(/[/\\]/.test(error.message), false);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peer attestation reports only what the host could prove", async () => {
  const root = await directory("ag-local-peer-");
  try {
    const secretFile = join(root, "local-control.secret");
    await writeFile(secretFile, Buffer.alloc(SECRET_BYTES), { mode: 0o600 });
    const peers = createOsLocalPeerIdentity({ secretFile });

    const socket = await peers.attest({ kind: "unix-socket", path: join(root, "local-control.sock") });
    assert.equal(socket.assurance, "os-acl-verified");
    assert.equal(socket.endpointOwnerVerified, true);
    assert.equal(socket.secretFileGuarded, true);

    // A pipe carries no OS access-control decision, so it may never claim one.
    const pipe = await peers.attest({ kind: "named-pipe", path: String.raw`\\.\pipe\ag-test` });
    assert.equal(pipe.assurance, "capability-only");

    for (const [address, expected] of [
      ["127.0.0.1", true],
      ["::1", true],
      ["::ffff:127.0.0.1", true],
      ["203.0.113.7", false],
      ["::ffff:203.0.113.7", false],
      [undefined, false],
    ] as const) {
      const loopback = await peers.attest(
        { kind: "loopback-http", address: "127.0.0.1", port: 8765 },
        address === undefined ? undefined : { peerAddress: address },
      );
      assert.equal(loopback.assurance, "capability-only", String(address));
      assert.equal(loopback.peerAddressIsLoopback, expected, String(address));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a peer the host could not examine is unverified with every flag false", async () => {
  const root = await directory("ag-local-peer-closed-");
  try {
    const missing = createOsLocalPeerIdentity({ secretFile: join(root, "absent.secret") });
    for (const endpoint of [
      { kind: "unix-socket" as const, path: join(root, "local-control.sock") },
      { kind: "named-pipe" as const, path: String.raw`\\.\pipe\ag-test` },
      { kind: "loopback-http" as const, address: "127.0.0.1", port: 8765 },
    ]) {
      const attestation = await missing.attest(endpoint);
      assert.equal(attestation.assurance, "unverified", endpoint.kind);
      assert.equal(attestation.endpointOwnerVerified, false, endpoint.kind);
      assert.equal(attestation.secretFileGuarded, false, endpoint.kind);
    }

    const wrongSize = join(root, "short.secret");
    await writeFile(wrongSize, Buffer.alloc(8), { mode: 0o600 });
    const short = await createOsLocalPeerIdentity({ secretFile: wrongSize })
      .attest({ kind: "named-pipe", path: String.raw`\\.\pipe\ag-test` });
    assert.equal(short.assurance, "unverified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate evidence is read only from inside its own directory", async () => {
  const root = await directory("ag-local-gates-");
  try {
    const inside = join(root, "gates");
    await mkdir(inside);
    const record = {
      sessionId: SESSION_ID,
      commit: COMMIT,
      gates: [{ name: "typecheck", passed: true }],
      recordedAt: "2026-08-09T10:00:00.000Z",
    };
    await writeFile(join(inside, `${SESSION_ID}.json`), JSON.stringify(record), "utf8");
    // The same file name one level up: a traversal that worked would find it.
    await writeFile(join(root, `${SESSION_ID}.json`), JSON.stringify(record), "utf8");

    const store = createFileSessionGateEvidenceStore(inside);
    const evidenceRead = await store.evidenceFor(SESSION_ID);
    assert.equal(evidenceRead?.commit, COMMIT);
    assert.deepEqual(evidenceRead?.gates.map((gate) => gate.name), ["typecheck"]);

    for (const hostile of [
      `../${SESSION_ID}`,
      `..\\${SESSION_ID}`,
      `../../${SESSION_ID}`,
      `%2e%2e%2f${SESSION_ID}`,
      `/${SESSION_ID}`,
      `C:/${SESSION_ID}`,
      `${SESSION_ID}/../${SESSION_ID}`,
      `${SESSION_ID}\u0000`,
      "not-a-uuid",
      "",
    ]) {
      assert.equal(await store.evidenceFor(hostile), undefined, hostile);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence that cannot be trusted reads as no evidence at all", async () => {
  const root = await directory("ag-local-gates-invalid-");
  try {
    const store = createFileSessionGateEvidenceStore(root);
    const write = async (value: unknown): Promise<void> => {
      await writeFile(join(root, `${SESSION_ID}.json`), JSON.stringify(value), "utf8");
    };
    const base = {
      sessionId: SESSION_ID,
      commit: COMMIT,
      gates: [{ name: "typecheck", passed: true }],
      recordedAt: "2026-08-09T10:00:00.000Z",
    };

    await writeFile(join(root, `${SESSION_ID}.json`), "{ not json", "utf8");
    assert.equal(await store.evidenceFor(SESSION_ID), undefined, "malformed JSON");

    for (const [label, value] of [
      ["another session", { ...base, sessionId: "223e4567-e89b-42d3-a456-426614174000" }],
      ["a short commit", { ...base, commit: "abc" }],
      ["an unrecorded instant", { ...base, recordedAt: "whenever" }],
      ["a non-boolean outcome", { ...base, gates: [{ name: "typecheck", passed: "yes" }] }],
      ["an unnamed gate", { ...base, gates: [{ passed: true }] }],
      ["a gate list that is not a list", { ...base, gates: {} }],
    ] as const) {
      await write(value);
      assert.equal(await store.evidenceFor(SESSION_ID), undefined, label);
    }

    await write(base);
    assert.equal((await store.evidenceFor(SESSION_ID))?.sessionId, SESSION_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The recorder and the reader are two capabilities over one file format, so the
 * only meaningful test of either is the round trip: a record the writer accepts
 * but the reader rejects would silently become "no gates ran".
 */

function evidence(overrides: Partial<SessionGateEvidence> = {}): SessionGateEvidence {
  return {
    sessionId: SESSION_ID,
    commit: COMMIT,
    gates: [
      { name: "typecheck", passed: true, status: "passed", durationMs: 1_200 },
      { name: "test", passed: false, status: "failed", durationMs: 42 },
    ],
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

test("recorded gate evidence reads back exactly as it was written", async () => {
  const root = await directory("ag-gate-evidence-roundtrip-");
  try {
    const home = join(root, "gates");
    await createFileSessionGateEvidenceRecorder(home).record(evidence());
    const read = await createFileSessionGateEvidenceStore(home).evidenceFor(SESSION_ID);
    assert.deepEqual(read, evidence());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the recorder refuses every record its own reader would discard", async () => {
  const root = await directory("ag-gate-evidence-refused-");
  try {
    const home = join(root, "gates");
    const recorder = createFileSessionGateEvidenceRecorder(home);
    const longName = "g".repeat(121);
    const cases: ReadonlyArray<readonly [string, SessionGateEvidence]> = [
      ["a session id that is not a UUID", evidence({ sessionId: "../escape" })],
      ["a commit that is not a full oid", evidence({ commit: "abc" })],
      ["an instant nobody can parse", evidence({ recordedAt: "whenever" })],
      ["one gate recorded twice", evidence({
        gates: [{ name: "test", passed: true }, { name: "test", passed: false }],
      })],
      ["a gate name longer than the format allows", evidence({
        gates: [{ name: longName, passed: true }],
      })],
    ];
    for (const [label, record] of cases) {
      await assert.rejects(
        recorder.record(record),
        (error: unknown) => error instanceof Error && /Gate evidence/.test(error.message),
        label,
      );
      assert.equal(
        await createFileSessionGateEvidenceStore(home).evidenceFor(SESSION_ID),
        undefined,
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed write leaves no half-record behind, and a second write replaces the first", async () => {
  const root = await directory("ag-gate-evidence-atomic-");
  try {
    const home = join(root, "gates");
    const recorder = createFileSessionGateEvidenceRecorder(home);
    await recorder.record(evidence());

    // A directory standing where the record belongs makes the rename fail after
    // the temporary file already exists — the one window in which a leftover
    // could survive.
    const blocked = join(root, "blocked");
    await mkdir(join(blocked, `${SESSION_ID}.json`), { recursive: true });
    await assert.rejects(
      createFileSessionGateEvidenceRecorder(blocked).record(evidence()),
      (error: unknown) => error instanceof Error && /Gate evidence could not be written/.test(error.message),
    );
    const leftovers = (await readdir(blocked)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "a temporary file outlived the failure");

    // Two records, one file: a reader must see the newer record whole, never a
    // mixture of the two.
    const replacement = evidence({
      commit: "b".repeat(40),
      gates: [{ name: "readme", passed: true }],
      recordedAt: "2026-08-09T11:00:00.000Z",
    });
    await recorder.record(replacement);
    assert.deepEqual(
      await createFileSessionGateEvidenceStore(home).evidenceFor(SESSION_ID),
      replacement,
    );
    assert.deepEqual((await readdir(home)).sort(), [`${SESSION_ID}.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an evidence file larger than the writer could produce is not read at all", async () => {
  const root = await directory("ag-gate-evidence-oversized-");
  try {
    const store = createFileSessionGateEvidenceStore(root);
    await writeFile(
      join(root, `${SESSION_ID}.json`),
      JSON.stringify({
        sessionId: SESSION_ID,
        commit: COMMIT,
        gates: [{ name: "typecheck", passed: true }],
        recordedAt: RECORDED_AT,
        padding: "p".repeat(64 * 1024),
      }),
      "utf8",
    );
    // The record is otherwise well formed, so only the size can refuse it: a
    // preview must never be turned into a memory exhaustion by a file the
    // gateway did not write.
    assert.equal(await store.evidenceFor(SESSION_ID), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
