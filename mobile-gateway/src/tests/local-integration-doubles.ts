import assert from "node:assert/strict";
import { LocalControlError } from "../application/local-control-errors.js";
import { LocalIntegrationService } from "../application/local-integration-service.js";
import type { SessionGateEvidence } from "../application/ports/session-gate-evidence-port.js";
import type {
  SessionRegistryStorePort,
  SessionRegistryUpdate,
} from "../application/ports/session-registry-store-port.js";
import type {
  IntegrationConfirmation,
  IntegrationPreview,
  LocalControlActor,
} from "../domain/command-intent.js";
import type {
  PersistedSessionRecord,
  SessionRegistrySnapshot,
} from "../domain/session-registry.js";
import type { WorktreeRecord } from "../domain/worktree-lifecycle.js";
import {
  fakeRepository,
  gateEvidence,
  gatePort,
  memoryRegistryStore,
  NOW,
  SESSION_ID,
  sessionRecord,
  worktreeRecord,
  type FakeRepository,
} from "./local-control-doubles.js";

/**
 * Shared fixture for the local integration suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `local-integration-flow.test.ts` buvo 686
 * eilučių). Fikstūra iškelta atskirai — ta pati konvencija kaip `local-control-doubles.ts` — kad
 * `local-integration-flow.test.ts` (atmetimai prieš merge) ir `local-integration-merge.test.ts`
 * (pats merge ir jo atsukimas) dalintųsi VIENU `writeCalls` apibrėžimu. Dvi kopijos to sąrašo
 * išsiskirtų tyliai, o būtent jis yra tai, kas paverčia „nė vieno rašymo" tikrinamu teiginiu.
 */

export const OWNER: LocalControlActor = { isLocalOsOwner: true };

/** Anything that could move a ref, discard work or rewrite history. */
const WRITE_COMMANDS = new Set([
  "merge",
  "push",
  "reset",
  "clean",
  "checkout",
  "switch",
  "rebase",
  "cherry-pick",
  "commit",
  "branch",
  "update-ref",
]);

export type Fixture = {
  service: LocalIntegrationService;
  repository: FakeRepository;
  registry: ReturnType<typeof memoryRegistryStore>;
  advance: (ms: number) => void;
  worktreeState: () => string;
  /** Every disposition the service wrote, in order. */
  worktreeStates: () => readonly string[];
};

export function fixture(options: {
  repository?: Partial<FakeRepository>;
  evidence?: SessionGateEvidence | undefined;
  worktree?: WorktreeRecord;
  previewTtlMs?: number;
  maxPreviews?: number;
  /** Session state the registry reports; omitted means no session record at all. */
  sessionState?: PersistedSessionRecord["state"];
  /**
   * Called after each disposition the service records. It is the only hook that
   * can move the repository at an exact point of the flow — "after
   * `locally_integrating` was journalled" is a moment no other double can name.
   */
  onWorktreeState?: (state: string) => void;
} = {}): Fixture {
  const repository = fakeRepository(options.repository ?? {});
  const worktrees = { [SESSION_ID]: options.worktree ?? worktreeRecord() };
  const registry = memoryRegistryStore(
    worktrees,
    options.sessionState === undefined ? {} : { [SESSION_ID]: sessionRecord(options.sessionState) },
  );
  const worktreeState = (): string => {
    const record: WorktreeRecord | undefined = registry.current().worktrees[SESSION_ID];
    return record === undefined ? "missing" : record.state;
  };
  const written: string[] = [];
  const watched: SessionRegistryStorePort = {
    async read() {
      return registry.read();
    },
    async update<T>(
      mutate: (current: SessionRegistrySnapshot) => SessionRegistryUpdate<T>,
    ): Promise<T> {
      const result = await registry.update(mutate);
      const state = worktreeState();
      written.push(state);
      options.onWorktreeState?.(state);
      return result;
    },
  };
  let now = new Date(NOW.getTime());
  const service = new LocalIntegrationService({
    git: repository.git,
    registry: watched,
    gates: gatePort("evidence" in options ? options.evidence : gateEvidence()),
    repositoryRootOf: async () => "/repository",
    clock: () => now,
    ...(options.previewTtlMs === undefined ? {} : { previewTtlMs: options.previewTtlMs }),
    ...(options.maxPreviews === undefined ? {} : { maxPreviews: options.maxPreviews }),
  });
  return {
    service,
    repository,
    registry,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
    worktreeState,
    worktreeStates: () => written,
  };
}

export function confirmationFor(
  preview: IntegrationPreview,
  overrides: Record<string, unknown> = {},
): IntegrationConfirmation {
  return {
    integrationId: preview.integrationId,
    sourceCommit: preview.sourceCommit,
    expectedTargetHead: preview.targetHead,
    diffDigest: preview.diffDigest,
    gateDigest: preview.gateDigest,
    strategy: "merge-no-ff",
    confirmation: "local-reauth-proof",
    ...overrides,
  } as IntegrationConfirmation;
}

export function writeCalls(repository: FakeRepository): string[][] {
  return repository.calls.filter((call) => WRITE_COMMANDS.has(call[0] ?? ""));
}

export async function rejectsWith(
  operation: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof LocalControlError && error.code === code,
    label,
  );
}
