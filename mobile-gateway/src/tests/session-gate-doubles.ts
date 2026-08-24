import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalControlError } from "../application/local-control-errors.js";
import type {
  GateCommandOutcome,
  GateCommandRunRequest,
  GateCommandRunnerPort,
} from "../application/ports/gate-command-runner-port.js";
import type { GitRunnerPort, GitRunResult } from "../application/ports/git-runner-port.js";
import type {
  SessionGateEvidence,
  SessionGateEvidenceWritePort,
} from "../application/ports/session-gate-evidence-port.js";
import type {
  SessionRegistryStorePort,
  SessionRegistryUpdate,
} from "../application/ports/session-registry-store-port.js";
import type {
  GateCommand,
  GateCommandCatalogue,
  RequiredGateName,
} from "../application/session-gate-policy.js";
import { SessionGateService } from "../application/session-gate-service.js";
import type { LocalControlActor } from "../domain/command-intent.js";
import type {
  PersistedSessionRecord,
  SessionRegistrySnapshot,
} from "../domain/session-registry.js";
import type { WorktreeRecord, WorktreeState } from "../domain/worktree-lifecycle.js";
import { NOW, SESSION_ID, sessionRecord, SOURCE_COMMIT, worktreeRecord } from "./local-control-doubles.js";

/**
 * Shared doubles for the quality gate suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-gates.test.ts` buvo 984 eilutės).
 * Fikstūra atskirai, nes `gateRegistry` yra vienintelė vieta, kur apibrėžta, ką reiškia
 * „registras buvo/nebuvo liestas": `reads()`, `updates()` ir `state()`. Trys kopijos trijuose
 * failuose išsiskirtų tyliai, ir dalis „nė vieno rašymo" teiginių nustotų ką nors reikšti.
 */

export const OWNER: LocalControlActor = { isLocalOsOwner: true };
export const OTHER_COMMIT = "d".repeat(40);
const GATEWAY_INSTANCE = "123e4567-e89b-42d3-a456-426614174012";
/** Written this way so the source file itself stays free of control characters. */
export const NUL = String.fromCharCode(0);

export const PASSED: GateCommandOutcome = Object.freeze({
  exitCode: 0,
  timedOut: false,
  startFailed: false,
  durationMs: 7,
});

// ---------------------------------------------------------------------------
// Catalogue helpers
// ---------------------------------------------------------------------------

/**
 * A gate command that carries its own name in its arguments. The runner port
 * deliberately never learns which gate it is running, so encoding the name is
 * the only way a test can assert the ORDER the service chose.
 */
export function gateCommand(name: RequiredGateName, overrides: Partial<GateCommand> = {}): GateCommand {
  return {
    name,
    executable: process.execPath,
    args: ["-e", `gate:${name}`],
    timeoutMs: 60_000,
    ...overrides,
  };
}

export function gateNameOf(request: GateCommandRunRequest): string {
  return String(request.args[1]).slice("gate:".length);
}

/** Every required gate, described in an order no part of the system may rely on. */
export function shuffledCatalogue(): GateCommandCatalogue {
  return [
    gateCommand("test"),
    gateCommand("secret"),
    gateCommand("readme"),
    gateCommand("typecheck"),
    gateCommand("architecture"),
  ];
}

export function catalogueWith(
  name: RequiredGateName,
  overrides: Partial<GateCommand>,
): GateCommandCatalogue {
  return shuffledCatalogue().map((command) => (
    command.name === name ? { ...command, ...overrides } : command
  ));
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

export type GitScript = {
  git: GitRunnerPort;
  /** Every argument vector the service asked Git to run, in order. */
  calls: string[][];
  /** Working directory of every call; the service must always pin it. */
  cwds: string[];
  head: string;
  branch: string;
  branchExitCode: number;
  status: string;
};

function scriptedGit(overrides: Partial<GitScript> = {}): GitScript {
  const script: GitScript = {
    git: { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } },
    calls: [],
    cwds: [],
    head: SOURCE_COMMIT,
    branch: `mobile/${SESSION_ID}`,
    branchExitCode: 0,
    status: "",
    ...overrides,
  };
  const answer = (args: readonly string[]): GitRunResult => {
    if (args[0] === "symbolic-ref") {
      return { exitCode: script.branchExitCode, stdout: `${script.branch}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { exitCode: 0, stdout: `${script.head}\n`, stderr: "" };
    }
    if (args[0] === "status") {
      return { exitCode: 0, stdout: script.status, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unscripted: ${args.join(" ")}` };
  };
  script.git = {
    async run(cwd, args) {
      script.calls.push([...args]);
      script.cwds.push(cwd);
      return answer(args);
    },
  };
  return script;
}

export type GateAnswer = (
  request: GateCommandRunRequest,
  index: number,
) => GateCommandOutcome | Promise<GateCommandOutcome>;

export type RunnerScript = {
  runner: GateCommandRunnerPort;
  calls: GateCommandRunRequest[];
};

function scriptedRunner(answer: GateAnswer = () => PASSED): RunnerScript {
  const calls: GateCommandRunRequest[] = [];
  return {
    calls,
    runner: {
      async run(request) {
        const index = calls.length;
        calls.push(request);
        return answer(request, index);
      },
    },
  };
}

export type EvidenceScript = {
  port: SessionGateEvidenceWritePort;
  records: SessionGateEvidence[];
};

/**
 * `after` runs once the record has been accepted. It is the only way a test can
 * act INSIDE the window between the disposition re-check and the registry write,
 * which is the window the service deliberately leaves open.
 */
function scriptedEvidence(fails = false, after?: () => void): EvidenceScript {
  const records: SessionGateEvidence[] = [];
  return {
    records,
    port: {
      async record(evidence) {
        records.push(evidence);
        if (fails) {
          throw new Error("the evidence directory is not writable");
        }
        after?.();
      },
    },
  };
}

export type GateRegistry = {
  store: SessionRegistryStorePort;
  reads(): number;
  updates(): number;
  state(): string;
  /** Moves the worktree behind the service's back, mid-run. */
  setState(state: WorktreeState): void;
  /** Drops the worktree record behind the service's back, mid-run. */
  remove(): void;
};

function gateRegistry(
  worktree: WorktreeRecord | undefined,
  session: PersistedSessionRecord | undefined,
): GateRegistry {
  let snapshot: SessionRegistrySnapshot = {
    version: 1,
    revision: 1,
    gatewayInstanceId: GATEWAY_INSTANCE,
    sessions: session === undefined ? {} : { [SESSION_ID]: session },
    worktrees: worktree === undefined ? {} : { [SESSION_ID]: worktree },
  };
  let reads = 0;
  let updates = 0;
  return {
    store: {
      async read() {
        reads += 1;
        return structuredClone(snapshot);
      },
      async update<T>(
        mutate: (current: SessionRegistrySnapshot) => SessionRegistryUpdate<T>,
      ): Promise<T> {
        // Counted before the mutation runs: an attempt that threw is still an
        // attempt, and several tests exist to prove none was ever made.
        updates += 1;
        const updated = mutate(structuredClone(snapshot));
        snapshot = updated.snapshot;
        return updated.result;
      },
    },
    reads: () => reads,
    updates: () => updates,
    state: () => {
      const record: WorktreeRecord | undefined = snapshot.worktrees[SESSION_ID];
      return record === undefined ? "missing" : record.state;
    },
    setState: (state) => {
      const record: WorktreeRecord | undefined = snapshot.worktrees[SESSION_ID];
      if (record === undefined) return;
      snapshot = {
        ...snapshot,
        worktrees: { ...snapshot.worktrees, [SESSION_ID]: { ...record, state } },
      };
    },
    remove: () => {
      const worktrees = { ...snapshot.worktrees };
      delete worktrees[SESSION_ID];
      snapshot = { ...snapshot, worktrees };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export type GateArea = {
  root: string;
  sessionRoot: string;
  worktreeRoot: string;
  outsideRoot: string;
};

/**
 * Real directories, because the service canonicalises both the configured root
 * and the recorded worktree through `realpath`. A fabricated path would make
 * every containment test pass or fail for a reason that is not the rule.
 */
async function gateArea(prefix: string): Promise<GateArea> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const sessionRoot = join(root, "sessions");
  const worktreeRoot = join(sessionRoot, SESSION_ID);
  const outsideRoot = join(root, "outside");
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { root, sessionRoot, worktreeRoot, outsideRoot };
}

export type GateContext = {
  service: SessionGateService;
  area: GateArea;
  git: GitScript;
  runner: RunnerScript;
  evidence: EvidenceScript;
  registry: GateRegistry;
  cleanup(): Promise<void>;
};

export type GateOptions = {
  prefix: string;
  worktreeState?: WorktreeState;
  /** `null` means the registry holds no session record at all. */
  sessionState?: PersistedSessionRecord["state"] | null;
  /** `"missing"` means no worktree record is journalled for the session. */
  worktree?: "missing";
  worktreeRootOf?: (area: GateArea) => string;
  sessionRootOf?: (area: GateArea) => string;
  git?: Partial<GitScript>;
  answer?: GateAnswer;
  evidenceFails?: boolean;
  /** Runs after a record is accepted, i.e. before the registry write. */
  afterEvidence?: () => void;
  catalogue?: GateCommandCatalogue;
};

export async function gateContext(options: GateOptions): Promise<GateContext> {
  const area = await gateArea(options.prefix);
  const worktreeRoot = (options.worktreeRootOf ?? ((value: GateArea) => value.worktreeRoot))(area);
  const sessionState = options.sessionState === undefined ? "ended" : options.sessionState;
  const registry = gateRegistry(
    options.worktree === "missing"
      ? undefined
      : worktreeRecord({ worktreeRoot, state: options.worktreeState ?? "ready" }),
    sessionState === null ? undefined : sessionRecord(sessionState),
  );
  const git = scriptedGit(options.git ?? {});
  const runner = scriptedRunner(options.answer);
  const evidence = scriptedEvidence(options.evidenceFails ?? false, options.afterEvidence);
  const service = new SessionGateService({
    registry: registry.store,
    git: git.git,
    runner: runner.runner,
    evidence: evidence.port,
    catalogue: options.catalogue ?? shuffledCatalogue(),
    sessionRoot: (options.sessionRootOf ?? ((value: GateArea) => value.sessionRoot))(area),
    clock: () => NOW,
  });
  return {
    service,
    area,
    git,
    runner,
    evidence,
    registry,
    cleanup: async () => {
      await rm(area.root, { recursive: true, force: true });
    },
  };
}

/**
 * `message` is asserted INSIDE the predicate, not passed to `assert.rejects` as
 * its third argument: that argument is only the label printed when the assertion
 * fails, so a message spelled there would never be compared to anything.
 */
export async function rejectsWith(
  operation: Promise<unknown>,
  code: string,
  label: string,
  message?: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof LocalControlError, label);
      assert.equal(error.code, code, label);
      if (message !== undefined) assert.equal(error.message, message, label);
      return true;
    },
    label,
  );
}

/** The refusal itself, for cases that compare two refusals against each other. */
export async function refusalOf(
  operation: Promise<unknown>,
  label: string,
): Promise<LocalControlError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof LocalControlError, `${label}: ${String(error)}`);
    return error;
  }
  return assert.fail(`${label}: the run should have been refused`);
}

/** Runs a case against a fresh fixture and always removes its directories. */
export async function withContext(
  options: GateOptions,
  body: (context: GateContext) => Promise<void>,
): Promise<void> {
  const context = await gateContext(options);
  try {
    await body(context);
  } finally {
    await context.cleanup();
  }
}
