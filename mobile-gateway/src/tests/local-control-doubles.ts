import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { DeviceAuthService } from "../application/device-auth-service.js";
import { LocalControlService } from "../application/local-control-service.js";
import { LocalIntegrationService } from "../application/local-integration-service.js";
import type { AuditEvent, AuditPort } from "../application/ports/audit-port.js";
import type { DeviceAuthStatePort } from "../application/ports/device-auth-state-port.js";
import type { GitRunnerPort, GitRunResult } from "../application/ports/git-runner-port.js";
import type { LocalControlRequest } from "../application/ports/local-control-listener-port.js";
import type { LocalControlSecretPort } from "../application/ports/local-control-secret-port.js";
import type {
  LocalPeerAttestation,
  LocalPeerAssurance,
} from "../application/ports/local-peer-identity-port.js";
import type { GateCommandRunnerPort } from "../application/ports/gate-command-runner-port.js";
import type { SessionGateEvidencePort, SessionGateEvidence } from "../application/ports/session-gate-evidence-port.js";
import type { SessionRegistryStorePort } from "../application/ports/session-registry-store-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import type { GateCommandCatalogue } from "../application/session-gate-policy.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import { SessionGateService } from "../application/session-gate-service.js";
import {
  TerminalSupervisor,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import type { DeviceAuthState } from "../domain/device-auth.js";
import type {
  PersistedSessionRecord,
  SessionRegistrySnapshot,
} from "../domain/session-registry.js";
import type { WorktreeRecord } from "../domain/worktree-lifecycle.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import { LocalControlRouter } from "../interfaces/http/local-control-router.js";

/**
 * Shared doubles for the local control tests.
 *
 * The proof builder is written out longhand rather than imported from the
 * verifier: restating the documented transcript is what makes the header format
 * itself part of what these tests assert.
 */

export const SESSION_ID = "123e4567-e89b-42d3-a456-426614174010";
export const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174011";
export const SOURCE_COMMIT = "a".repeat(40);
export const TARGET_HEAD = "b".repeat(40);
export const MERGE_COMMIT = "c".repeat(40);

export const NOW = new Date("2026-08-09T10:00:00.000Z");

export function testSecret(): Uint8Array {
  return new Uint8Array(Buffer.from("local-control-test-secret-32byte", "utf8"));
}

export function localProofHeader(input: {
  secret: Uint8Array;
  method: string;
  path: string;
  body?: Uint8Array;
  now: Date;
  nonce?: string;
}): string {
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const timestamp = input.now.toISOString();
  const bodyDigest = createHash("sha256").update(input.body ?? new Uint8Array()).digest("hex");
  const mac = createHmac("sha256", input.secret)
    .update([
      "ag-local-v1",
      input.method.toUpperCase(),
      input.path,
      bodyDigest,
      nonce,
      timestamp,
    ].join("\n"), "utf8")
    .digest("base64url");
  return `v1:${nonce}:${timestamp}:${mac}`;
}

export function attestation(
  overrides: Partial<LocalPeerAttestation> & { assurance?: LocalPeerAssurance } = {},
): LocalPeerAttestation {
  return Object.freeze({
    transport: "unix-socket" as const,
    assurance: "os-acl-verified" as const,
    endpointOwnerVerified: true,
    secretFileGuarded: true,
    observedAt: NOW.toISOString(),
    ...overrides,
  });
}

export function secretPort(secret: Uint8Array, fileGuarded = true): LocalControlSecretPort {
  return { async load() { return { secret, fileGuarded }; } };
}

/** Builds a signed local request; `proof: null` omits the header entirely. */
export function localRequest(input: {
  secret: Uint8Array;
  path: string;
  method?: string;
  body?: Uint8Array | Record<string, unknown>;
  now?: Date;
  nonce?: string;
  proof?: string | null;
  peer?: LocalPeerAttestation;
  headers?: Record<string, string | undefined>;
}): LocalControlRequest {
  const method = input.method ?? "POST";
  const now = input.now ?? NOW;
  const body = input.body === undefined
    ? undefined
    : input.body instanceof Uint8Array
      ? input.body
      : new Uint8Array(Buffer.from(JSON.stringify(input.body), "utf8"));
  const proof = input.proof === null
    ? undefined
    : input.proof ?? localProofHeader({
      secret: input.secret,
      method,
      path: input.path,
      ...(body ? { body } : {}),
      now,
      ...(input.nonce ? { nonce: input.nonce } : {}),
    });
  return {
    method,
    path: input.path,
    headers: {
      host: "127.0.0.1:8765",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(proof ? { "x-ag-local-proof": proof } : {}),
      ...input.headers,
    },
    ...(body ? { body } : {}),
    peer: input.peer ?? attestation(),
  };
}

export function worktreeRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return Object.freeze({
    sessionId: SESSION_ID,
    branch: `mobile/${SESSION_ID}`,
    baseCommit: TARGET_HEAD,
    worktreeRoot: `/sessions/${SESSION_ID}`,
    state: "review_ready" as const,
    ...overrides,
  });
}

/**
 * Persisted session record for a session that has already finished.
 *
 * The review rule asks the registry whether the agent process ended, so a test
 * that expects reviewable work has to say so here rather than let the preview
 * assume it.
 */
export function sessionRecord(
  state: PersistedSessionRecord["state"] = "ended",
): PersistedSessionRecord {
  return Object.freeze({
    sessionId: SESSION_ID,
    projectId: "123e4567-e89b-42d3-a456-426614174013",
    provider: "claude-code" as const,
    worktreeRoot: `/sessions/${SESSION_ID}`,
    branch: `mobile/${SESSION_ID}`,
    baseCommit: TARGET_HEAD,
    state,
    lease: {
      leaseId: "123e4567-e89b-42d3-a456-426614174014",
      ownerDeviceId: DEVICE_ID,
      generation: 1,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      status: "expired" as const,
    },
    gatewayInstanceId: "123e4567-e89b-42d3-a456-426614174012",
  });
}

export function memoryRegistryStore(
  worktrees: Readonly<Record<string, WorktreeRecord>> = { [SESSION_ID]: worktreeRecord() },
  sessions: Readonly<Record<string, PersistedSessionRecord>> = {},
): SessionRegistryStorePort & { current(): SessionRegistrySnapshot } {
  let snapshot: SessionRegistrySnapshot = {
    version: 1,
    revision: 1,
    gatewayInstanceId: "123e4567-e89b-42d3-a456-426614174012",
    sessions,
    worktrees,
  };
  return {
    async read() {
      return structuredClone(snapshot);
    },
    async update(mutate) {
      const updated = mutate(structuredClone(snapshot));
      snapshot = updated.snapshot;
      return updated.result;
    },
    current() {
      return snapshot;
    },
  };
}

export function gateEvidence(overrides: Partial<SessionGateEvidence> = {}): SessionGateEvidence {
  return Object.freeze({
    sessionId: SESSION_ID,
    commit: SOURCE_COMMIT,
    // Every gate `design.md` §7 requires, green: the integration flow refuses a
    // record that is missing one, so a shorter default would make every test
    // that expects a passing preview fail for a reason it is not about.
    gates: [
      { name: "readme", passed: true },
      { name: "architecture", passed: true },
      { name: "secret", passed: true },
      { name: "typecheck", passed: true },
      { name: "test", passed: true },
    ],
    recordedAt: NOW.toISOString(),
    ...overrides,
  });
}

export function gatePort(evidence: SessionGateEvidence | undefined): SessionGateEvidencePort {
  return { async evidenceFor() { return evidence; } };
}

export type FakeRepository = {
  git: GitRunnerPort;
  /** Every argument vector the service asked Git to run, in order. */
  calls: string[][];
  head: string;
  sourceCommit: string;
  targetBranch: string;
  status: string;
  changedFiles: string[];
  diff: string;
  mergeExitCode: number;
  abortExitCode: number;
  /** HEAD a successful `merge --abort` restores; not the previewed target when a rollback lands elsewhere. */
  headAfterAbort: string;
  /** Parents `rev-list --parents -n 1 HEAD` reports; a shorter list is a merge that did not merge. */
  mergeParents: readonly string[];
};

/**
 * Scripted Git. It answers the plumbing the integration flow reads and records
 * every call, so a test can assert not only the outcome but that no write
 * command was ever attempted.
 */
export function fakeRepository(overrides: Partial<FakeRepository> = {}): FakeRepository {
  const repository: FakeRepository = {
    git: { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } },
    calls: [],
    head: TARGET_HEAD,
    sourceCommit: SOURCE_COMMIT,
    targetBranch: "main",
    status: "",
    changedFiles: ["src/domain/command-intent.ts"],
    diff: "@@ -0,0 +1 @@\n+local\n",
    mergeExitCode: 0,
    abortExitCode: 0,
    headAfterAbort: TARGET_HEAD,
    mergeParents: [TARGET_HEAD, SOURCE_COMMIT],
    ...overrides,
  };
  const answer = (args: readonly string[]): GitRunResult => {
    const ok = (stdout: string): GitRunResult => ({ exitCode: 0, stdout, stderr: "" });
    if (args[0] === "rev-parse") {
      return ok(args[2] === "HEAD^{commit}" ? repository.head : repository.sourceCommit);
    }
    if (args[0] === "symbolic-ref") return ok(repository.targetBranch);
    if (args[0] === "status") return ok(repository.status);
    if (args[0] === "diff") {
      return ok(args[1] === "--name-only" ? repository.changedFiles.join("\n") : repository.diff);
    }
    if (args[0] === "rev-list") {
      return ok(`${repository.head} ${repository.mergeParents.join(" ")}`);
    }
    if (args[0] === "merge" && args[1] === "--abort") {
      if (repository.abortExitCode === 0) repository.head = repository.headAfterAbort;
      return { exitCode: repository.abortExitCode, stdout: "", stderr: "" };
    }
    if (args[0] === "merge") {
      if (repository.mergeExitCode === 0) repository.head = MERGE_COMMIT;
      return { exitCode: repository.mergeExitCode, stdout: "", stderr: "conflict" };
    }
    return { exitCode: 1, stdout: "", stderr: `unscripted: ${args.join(" ")}` };
  };
  repository.git = {
    async run(_cwd, args) {
      repository.calls.push([...args]);
      return answer(args);
    },
  };
  return repository;
}

export function inMemoryDeviceAuthState(): DeviceAuthStatePort {
  let state: DeviceAuthState = {
    version: 1,
    issuer: "ag-mobile-gateway",
    audience: "ag-mobile-app",
    accessSigningKey: randomBytes(32).toString("base64url"),
    challenges: {},
    devices: {},
    refreshTokens: {},
  };
  return {
    async read() {
      return structuredClone(state);
    },
    async update(mutate) {
      const updated = mutate(state);
      state = updated.state;
      return updated.result;
    },
  };
}

/**
 * A gate catalogue that is valid host configuration and never runs anything: the
 * runner double below refuses every command, and the service turns that into an
 * `errored` gate rather than an exception. The router fixture only needs a gate
 * RUN to happen, not a real build.
 */
function fixtureCatalogue(): GateCommandCatalogue {
  return REQUIRED_GATE_NAMES.map((name) => ({
    name,
    executable: process.execPath,
    args: ["-e", `gate:${name}`],
    timeoutMs: 60_000,
  }));
}

export type RouterFixture = {
  router: LocalControlRouter;
  audit: InMemoryAuditLog;
  auditEvents: () => readonly AuditEvent[];
  repository: FakeRepository;
  registry: ReturnType<typeof memoryRegistryStore>;
  control: LocalControlService;
  integrations: LocalIntegrationService;
  gates: SessionGateService;
  /** Every gate record the service wrote through the fixture's evidence double. */
  gateRecords: SessionGateEvidence[];
  supervisor: TerminalSupervisor;
  secret: Uint8Array;
  disconnected: Array<readonly string[]>;
};

/**
 * A router wired to real services over doubles.
 *
 * The services are the production classes on purpose: a stubbed service could
 * not show that a refused transport never reaches one, which is the property
 * most of these tests exist to prove.
 */
export async function routerFixture(options: {
  audit?: AuditPort;
  evidence?: SessionGateEvidence | undefined;
  worktrees?: Readonly<Record<string, WorktreeRecord>>;
  /** Persisted session records; a gate run needs one that has already finished. */
  sessions?: Readonly<Record<string, PersistedSessionRecord>>;
  /** Root every gate worktree must resolve inside; defaults to the OS temp dir. */
  gateSessionRoot?: string;
  secretGuarded?: boolean;
  loopbackPort?: number;
  allowCapabilityOnlyAssurance?: boolean;
} = {}): Promise<RouterFixture> {
  const secret = testSecret();
  const auditLog = new InMemoryAuditLog();
  const audit = options.audit ?? auditLog;
  const repository = fakeRepository();
  const registry = memoryRegistryStore(options.worktrees, options.sessions);
  const disconnected: Array<readonly string[]> = [];
  const worktrees: WorktreeAllocationPort = {
    async allocate() {
      throw new Error("the local fixture never allocates a worktree");
    },
  };
  const supervisor = new TerminalSupervisor({
    projects: await ProjectRegistry.create({ personal: tmpdir() }),
    git: repository.git,
    worktrees,
    terminals: { async start() { throw new Error("the local fixture never starts a terminal"); } },
    clock: () => NOW,
  });
  const control = new LocalControlService({
    deviceAuth: new DeviceAuthService(inMemoryDeviceAuthState()),
    terminals: supervisor,
    hostFingerprint: () => "sha256:33333333333333333333333333333333",
    pairingOrigin: () => "https://127.0.0.1:8443",
    clock: () => NOW,
    disconnectStreams: async (sessionIds) => {
      disconnected.push(sessionIds);
    },
  });
  const integrations = new LocalIntegrationService({
    git: repository.git,
    registry,
    gates: gatePort("evidence" in options ? options.evidence : gateEvidence()),
    repositoryRootOf: async () => "/repository",
    clock: () => NOW,
  });
  const gateRecords: SessionGateEvidence[] = [];
  const gateRunner: GateCommandRunnerPort = {
    async run() {
      // The service records a runner that throws as an `errored` gate, so the
      // fixture gets a complete run without executing a build.
      throw new Error("the local fixture never runs a real gate command");
    },
  };
  const gates = new SessionGateService({
    registry,
    git: repository.git,
    runner: gateRunner,
    evidence: {
      async record(evidence) {
        gateRecords.push(evidence);
      },
    },
    catalogue: fixtureCatalogue(),
    sessionRoot: options.gateSessionRoot ?? tmpdir(),
    clock: () => NOW,
  });
  const router = new LocalControlRouter({
    control,
    integrations,
    gates,
    secrets: secretPort(secret, options.secretGuarded ?? true),
    peerPolicy: { allowCapabilityOnlyAssurance: options.allowCapabilityOnlyAssurance ?? false },
    audit,
    ...(options.loopbackPort === undefined ? {} : { loopbackPort: options.loopbackPort }),
    now: () => NOW,
  });
  return {
    router,
    audit: auditLog,
    auditEvents: () => auditLog.entries(),
    repository,
    registry,
    control,
    integrations,
    gates,
    gateRecords,
    supervisor,
    secret,
    disconnected,
  };
}

/** Every local route, with a body that would be valid if it were reached. */
export function everyLocalRoute(): ReadonlyArray<{ path: string; body?: Record<string, unknown> }> {
  return [
    { path: "/v1/local/pairing-challenges", body: { deviceName: "Owner phone", scopes: ["ag:read"] } },
    {
      path: `/v1/local/terminal-sessions/${SESSION_ID}/force-close`,
      body: { requestId: randomUUID(), reason: "Owner requested local recovery", expectedSessionRevision: 3 },
    },
    { path: `/v1/local/terminal-sessions/${SESSION_ID}/gates` },
    { path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview` },
    {
      path: `/v1/local/terminal-sessions/${SESSION_ID}/integrate`,
      body: {
        integrationId: randomUUID(),
        sourceCommit: SOURCE_COMMIT,
        expectedTargetHead: TARGET_HEAD,
        diffDigest: `sha256:${"1".repeat(64)}`,
        gateDigest: `sha256:${"2".repeat(64)}`,
        strategy: "merge-no-ff",
        confirmation: "local-reauth-proof",
      },
    },
    { path: `/v1/local/devices/${DEVICE_ID}/revoke`, body: { requestId: randomUUID(), reason: "Lost device" } },
  ];
}
