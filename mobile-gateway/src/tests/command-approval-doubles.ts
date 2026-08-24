import assert from "node:assert/strict";
import {
  CommandApprovalService,
  type ApprovedCommand,
  type CommandPrincipal,
} from "../application/command-approval-service.js";
import type { AuditPort } from "../application/ports/audit-port.js";
import type { AnyCommandIntent } from "../domain/command-intent.js";
import { CommandIntentError } from "../domain/command-intent.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";

/**
 * Shared doubles for the command approval suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `command-approval.test.ts` buvo 843 eilutės).
 * Fikstūra atskirai, nes `countingExecutor` yra tai, kas paverčia „portas NEBUVO pasiektas"
 * teiginiu, o ne viltimi. Trys jo kopijos trijuose failuose išsiskirtų tyliai, ir dalis
 * „executor.calls === 0" teiginių nustotų ką nors reikšti.
 */

export const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
export const OTHER_DEVICE_ID = "123e4567-e89b-42d3-a456-4266141740ff";
export const IDEMPOTENCY_KEY = `${DEVICE_ID}:7`;
export const PR_TITLE = "Fix the failing dispatch tests";

export function owner(overrides: Partial<CommandPrincipal> = {}): CommandPrincipal {
  return {
    principalId: "owner",
    deviceId: DEVICE_ID,
    isOwner: true,
    scopes: ["ag:read", "terminal:write", "github:read", "github:write"],
    ...overrides,
  };
}

export function pullRequestIntent(overrides: Record<string, unknown> = {}): AnyCommandIntent {
  return {
    commandId: "command-1",
    idempotencyKey: IDEMPOTENCY_KEY,
    deviceId: DEVICE_ID,
    principalId: "owner",
    projectId: "project-1",
    action: "github.pull_request.create",
    payload: { sessionId: "session-1", title: PR_TITLE, draft: true },
    requestedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  } as AnyCommandIntent;
}

export function connectIntent(overrides: Record<string, unknown> = {}): AnyCommandIntent {
  return {
    commandId: "command-2",
    idempotencyKey: `${DEVICE_ID}:11`,
    deviceId: DEVICE_ID,
    principalId: "owner",
    action: "github.connection.begin",
    payload: {},
    requestedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  } as AnyCommandIntent;
}

/** Deterministic ids, so a challenge and an event id are distinguishable in an assertion. */
function identifiers(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

export type Harness = Readonly<{
  approvals: CommandApprovalService;
  audit: InMemoryAuditLog;
  advance: (ms: number) => void;
}>;

export function harness(overrides: { audit?: AuditPort; approvalTtlMs?: number } = {}): Harness {
  const audit = new InMemoryAuditLog();
  let nowMs = Date.parse("2026-08-10T10:00:00.000Z");
  const approvals = new CommandApprovalService({
    audit: overrides.audit ?? audit,
    clock: () => new Date(nowMs),
    newId: identifiers(),
    ...(overrides.approvalTtlMs === undefined ? {} : { approvalTtlMs: overrides.approvalTtlMs }),
  });
  return {
    approvals,
    audit,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** Records every call so "the port was never reached" is an assertion, not a hope. */
export function countingExecutor(): { calls: number; run: (approved: ApprovedCommand) => Promise<string> } {
  const state = {
    calls: 0,
    run: async (approved: ApprovedCommand): Promise<string> => {
      state.calls += 1;
      return `ran:${approved.commandId}:${state.calls}`;
    },
  };
  return state;
}

export async function rejects(
  operation: () => Promise<unknown>,
  code: string,
): Promise<CommandIntentError> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof CommandIntentError, `expected a CommandIntentError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected the command to be refused with ${code}`);
}

export function actions(audit: InMemoryAuditLog): string[] {
  return audit.entries().map((event) => `${event.action}:${event.outcome}`);
}
