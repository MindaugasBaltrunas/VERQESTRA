/**
 * Structured control-plane command contract — transport neutral.
 *
 * `spec.md` ("Komandų perdavimas") separates two mobile inputs that look alike
 * and must never share a code path: free-form terminal input, which is delivered
 * to an agent PTY and whose effect the gateway deliberately does not predict,
 * and a *structured command* (GitHub, project, local integration), which is a
 * decision the host makes before anything happens.
 *
 * This file defines only the second one. A command is submitted as a
 * {@link CommandIntent}: an enumerated {@link CommandAction} plus a closed
 * payload. There is no free-form command string, so a mis-recognised voice
 * phrase cannot become a shell line — `design.md` §10: "Mobile negeneruoja `gh`
 * ar `git` shell eilučių."
 *
 * Two rules are enforced by shape rather than by discipline:
 *
 * - **Risk is not client input.** {@link CommandIntent} has no `risk` field.
 *   Risk comes from {@link COMMAND_AUTHORITY}, the host-owned catalog, exactly
 *   as `design.md` §11 requires ("Klientas negali pats pakeisti `risk`").
 * - **Blocked stays blocked.** Remote branch integration is declared here as a
 *   `blocked` action instead of being merely absent, so a client that asks for
 *   it receives an explicit, auditable refusal.
 *
 * The second half of this file covers the local-only preview/confirm flow of
 * `local-control-contract.md`: an integration preview is immutable and
 * short-lived, and {@link assertIntegrationConfirmation} re-checks every digest
 * and every Git fact at confirm time, so what the operator approved is what is
 * applied (TOCTOU revalidation).
 */

import type { DeviceScope } from "./device-auth.js";

/**
 * Failure of a command-intent or local-control precondition.
 *
 * Codes are drawn from the gateway error envelope so a transport handler maps
 * them straight through without inventing a second vocabulary.
 */
export type CommandIntentErrorCode =
  | "forbidden"
  | "invalid_request"
  | "duplicate_request"
  | "conflict";

export class CommandIntentError extends Error {
  constructor(readonly code: CommandIntentErrorCode, message: string) {
    super(message);
    this.name = "CommandIntentError";
  }
}

/**
 * Host classification of what a command may do.
 *
 * `safe` executes on scope alone, `confirm` additionally needs a one-time
 * approval challenge, `blocked` can never execute through the remote surface.
 */
export type CommandRisk = "safe" | "confirm" | "blocked";

export type CommandAction =
  | "github.connection.begin"
  | "github.connection.revoke"
  | "github.issue.import"
  | "github.pull_request.create"
  | "project.create"
  | "git.integration.merge"
  | "git.integration.rebase"
  | "git.integration.cherry_pick"
  | "git.push.protected_branch";

/** Closed payload per action; nothing here is a command line or a host path. */
export type CommandPayloads = {
  "github.connection.begin": Record<string, never>;
  "github.connection.revoke": Record<string, never>;
  "github.issue.import": Readonly<{ issueNumber: number }>;
  "github.pull_request.create": Readonly<{ sessionId: string; title: string; draft: boolean }>;
  "project.create": Readonly<{ workspaceRootId: string; name: string }>;
  "git.integration.merge": Record<string, never>;
  "git.integration.rebase": Record<string, never>;
  "git.integration.cherry_pick": Record<string, never>;
  "git.push.protected_branch": Record<string, never>;
};

export type CommandAuthority = Readonly<{
  /**
   * Device scope required to submit the action, or `null` when no device scope
   * grants it. `null` together with `ownerOnly` marks an action reachable only
   * to the paired owner principal.
   */
  scope: DeviceScope | null;
  /** True when scopes alone are never sufficient. */
  ownerOnly: boolean;
  risk: CommandRisk;
}>;

/**
 * The authoritative classification. Every action is listed exactly once, so an
 * action added to {@link CommandAction} without a decision here fails to
 * compile rather than defaulting to permitted.
 *
 * Branch integration is `blocked`: `spec.md` keeps merge, cherry-pick and
 * rebase out of the remote surface entirely — the operator performs them
 * locally through the preview/confirm flow at the bottom of this file.
 */
export const COMMAND_AUTHORITY: Readonly<Record<CommandAction, CommandAuthority>> = Object.freeze({
  "github.connection.begin": { scope: "github:write", ownerOnly: true, risk: "confirm" },
  "github.connection.revoke": { scope: "github:write", ownerOnly: true, risk: "confirm" },
  "github.issue.import": { scope: "github:read", ownerOnly: false, risk: "safe" },
  "github.pull_request.create": { scope: "github:write", ownerOnly: false, risk: "confirm" },
  "project.create": { scope: null, ownerOnly: true, risk: "confirm" },
  "git.integration.merge": { scope: null, ownerOnly: true, risk: "blocked" },
  "git.integration.rebase": { scope: null, ownerOnly: true, risk: "blocked" },
  "git.integration.cherry_pick": { scope: null, ownerOnly: true, risk: "blocked" },
  "git.push.protected_branch": { scope: null, ownerOnly: true, risk: "blocked" },
});

export type CommandIntent<A extends CommandAction = CommandAction> = Readonly<{
  /** Client-generated correlation id; never trusted as authorisation. */
  commandId: string;
  /** `<deviceId>:<monotonic counter>` — see {@link assertCommandIdempotencyKey}. */
  idempotencyKey: string;
  deviceId: string;
  principalId: string;
  /** Absent for host-wide actions such as connecting GitHub. */
  projectId?: string;
  action: A;
  payload: CommandPayloads[A];
  /** ISO-8601 UTC instant the client submitted the intent. */
  requestedAt: string;
}>;

/** Discriminated union over every action, keeping `action` and `payload` correlated. */
export type AnyCommandIntent = { [A in CommandAction]: CommandIntent<A> }[CommandAction];

export type CommandDecision = "accepted" | "confirmation_required" | "rejected" | "duplicate";

export type CommandDecisionResult = Readonly<{
  commandId: string;
  decision: CommandDecision;
  risk: CommandRisk;
  /** Why a command was refused; absent when it was accepted. */
  reasonCode?: CommandIntentErrorCode;
  /**
   * One-time approval challenge the client must return to convert a
   * `confirmation_required` decision into an accepted one.
   */
  approvalChallengeId?: string;
}>;

export type CommandDecisionContext = Readonly<{
  /** Device the authenticated access token belongs to. */
  deviceId: string;
  /** True when the caller is the paired owner principal. */
  isOwner: boolean;
  scopes: readonly DeviceScope[];
  /**
   * Approval challenge the gateway has already verified as issued for this
   * command and not yet used. A client-supplied value that failed verification
   * must not be passed here.
   */
  verifiedApprovalChallengeId?: string;
  /**
   * Decision the command ledger already recorded for this idempotency key, if
   * any. Its presence is what makes a replay observable.
   */
  ledgerDecision?: CommandDecisionResult;
  /** Mints a fresh one-time approval challenge id. */
  issueApprovalChallenge: () => string;
}>;

const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
const IDEMPOTENCY_KEY_MAX_LENGTH = 160;
const IDEMPOTENCY_KEY = /^(?<deviceId>.+):(?<counter>\d{1,20})$/;

/**
 * `design.md` §11 fixes the key as `device-id:monotonic-counter`. Binding the
 * key to the calling device is the point: a key observed on the wire cannot be
 * replayed by another device to claim its ledger entry.
 */
export function assertCommandIdempotencyKey(key: string, deviceId: string): void {
  if (
    typeof key !== "string" ||
    key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    throw new CommandIntentError(
      "invalid_request",
      `Idempotency key must be ${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  const groups = IDEMPOTENCY_KEY.exec(key)?.groups;
  if (!groups) {
    throw new CommandIntentError("invalid_request", "Idempotency key must be <deviceId>:<counter>");
  }
  if (groups["deviceId"] !== deviceId) {
    throw new CommandIntentError("forbidden", "Idempotency key belongs to another device");
  }
}

/**
 * Decide a structured command without executing anything.
 *
 * Structural violations (an intent that does not belong to the caller, a
 * malformed key, an unknown action) throw: they are malformed requests, not
 * policy outcomes. Policy outcomes are returned as a
 * {@link CommandDecisionResult} so the caller can audit and answer with the
 * decision-first response shape of `design.md` §11.
 */
export function decideCommandIntent(
  intent: AnyCommandIntent,
  context: CommandDecisionContext,
): CommandDecisionResult {
  if (intent.deviceId !== context.deviceId) {
    throw new CommandIntentError("forbidden", "Command intent was submitted for another device");
  }
  assertCommandIdempotencyKey(intent.idempotencyKey, context.deviceId);

  const authority = COMMAND_AUTHORITY[intent.action];
  if (!authority) {
    throw new CommandIntentError("invalid_request", `Unknown command action: ${intent.action}`);
  }

  // A replay never re-executes; the first outcome is what the client learns.
  if (context.ledgerDecision) {
    return Object.freeze({
      commandId: context.ledgerDecision.commandId,
      decision: "duplicate" as const,
      risk: context.ledgerDecision.risk,
      reasonCode: "duplicate_request" as const,
    });
  }

  const reject = (reasonCode: CommandIntentErrorCode): CommandDecisionResult =>
    Object.freeze({ commandId: intent.commandId, decision: "rejected" as const, risk: authority.risk, reasonCode });

  if (authority.risk === "blocked") return reject("forbidden");
  if (authority.ownerOnly && !context.isOwner) return reject("forbidden");
  if (authority.scope !== null && !context.scopes.includes(authority.scope)) return reject("forbidden");

  if (authority.risk === "confirm" && context.verifiedApprovalChallengeId === undefined) {
    return Object.freeze({
      commandId: intent.commandId,
      decision: "confirmation_required" as const,
      risk: authority.risk,
      approvalChallengeId: context.issueApprovalChallenge(),
    });
  }

  return Object.freeze({
    commandId: intent.commandId,
    decision: "accepted" as const,
    risk: authority.risk,
  });
}

/* ------------------------------------------------------------------------- *
 * Local-only control intents (`local-control-contract.md`)
 *
 * These never appear on the remote listener. They are reachable only to the
 * authenticated local OS user, and their execution lives in the supervisor and
 * the local transport; what is defined here is the contract they must satisfy.
 * ------------------------------------------------------------------------- */

/** The only branch integration strategy allowed in V1. */
export type IntegrationStrategy = "merge-no-ff";

export const INTEGRATION_STRATEGIES: readonly IntegrationStrategy[] = Object.freeze(["merge-no-ff"]);

/** `sha256:<64 lowercase hex>` — the digest form used across the local contract. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function assertDigest(value: string, field: string): void {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new CommandIntentError("invalid_request", `${field} must be a sha256:<hex> digest`);
  }
}

export type LocalControlActor = Readonly<{
  /** The local transport proved the caller is the owning OS user. */
  isLocalOsOwner: boolean;
  /** ISO-8601 instant of the local re-authentication proof, if one was made. */
  reauthenticatedAt?: string;
}>;

/**
 * Immutable, short-lived description of what integrating a session would do.
 * Paths are repository-relative and no Git state is changed to produce it.
 */
export type IntegrationPreview = Readonly<{
  integrationId: string;
  sessionId: string;
  sourceBranch: string;
  sourceCommit: string;
  targetBranch: string;
  targetHead: string;
  changedFiles: readonly string[];
  diffDigest: string;
  gateDigest: string;
  gatesPassed: boolean;
  targetClean: boolean;
  expiresAt: string;
}>;

/** What the operator sends back after reading the preview. */
export type IntegrationConfirmation = Readonly<{
  integrationId: string;
  sourceCommit: string;
  expectedTargetHead: string;
  diffDigest: string;
  gateDigest: string;
  strategy: IntegrationStrategy;
  /** Opaque local re-authentication proof; never a credential the gateway stores. */
  confirmation: string;
}>;

/** Repository facts observed again at confirm time, not carried from the preview. */
export type IntegrationRevalidation = Readonly<{
  now: Date;
  /** True when the preview was already used by an earlier confirm. */
  previewConsumed: boolean;
  observedSourceCommit: string;
  observedTargetHead: string;
  observedTargetClean: boolean;
  observedDiffDigest: string;
  observedGateDigest: string;
  observedGatesPassed: boolean;
  actor: LocalControlActor;
}>;

/**
 * Revalidate a confirmation against its preview and against freshly observed
 * repository state, in the order `local-control-contract.md` lists.
 *
 * The two comparison directions are kept apart on purpose: a mismatch between
 * the confirmation and the preview means the client sent back something other
 * than what was shown (`invalid_request`), while a mismatch between the preview
 * and the observed repository means the world moved after the operator looked
 * (`conflict`). Collapsing them would hide which side drifted.
 *
 * Throws on the first failure; returns normally when the integration may
 * proceed. It performs no Git action itself.
 */
export function assertIntegrationConfirmation(
  preview: IntegrationPreview,
  confirmation: IntegrationConfirmation,
  observed: IntegrationRevalidation,
): void {
  if (!observed.actor.isLocalOsOwner || observed.actor.reauthenticatedAt === undefined) {
    throw new CommandIntentError("forbidden", "Integration requires the local OS owner and a local re-auth proof");
  }
  if (confirmation.integrationId !== preview.integrationId) {
    throw new CommandIntentError("invalid_request", "Confirmation does not belong to this preview");
  }
  if (!INTEGRATION_STRATEGIES.includes(confirmation.strategy)) {
    throw new CommandIntentError("invalid_request", `Unsupported integration strategy: ${confirmation.strategy}`);
  }
  if (observed.previewConsumed) {
    throw new CommandIntentError("duplicate_request", "Integration preview was already used");
  }
  if (observed.now.getTime() >= Date.parse(preview.expiresAt)) {
    throw new CommandIntentError("conflict", "Integration preview expired");
  }

  for (const [field, shown, sent] of [
    ["diffDigest", preview.diffDigest, confirmation.diffDigest],
    ["gateDigest", preview.gateDigest, confirmation.gateDigest],
  ] as const) {
    assertDigest(shown, `preview ${field}`);
    assertDigest(sent, `confirmation ${field}`);
    if (shown !== sent) {
      throw new CommandIntentError("invalid_request", `Confirmed ${field} differs from the previewed one`);
    }
  }
  if (confirmation.sourceCommit !== preview.sourceCommit) {
    throw new CommandIntentError("invalid_request", "Confirmed source commit differs from the previewed one");
  }
  if (confirmation.expectedTargetHead !== preview.targetHead) {
    throw new CommandIntentError("invalid_request", "Confirmed target head differs from the previewed one");
  }

  if (observed.observedSourceCommit !== preview.sourceCommit) {
    throw new CommandIntentError("conflict", "Session branch moved after the preview");
  }
  if (observed.observedTargetHead !== preview.targetHead) {
    throw new CommandIntentError("conflict", "Target branch moved after the preview");
  }
  if (!observed.observedTargetClean || !preview.targetClean) {
    throw new CommandIntentError("conflict", "Target working tree and index must be clean");
  }
  if (observed.observedDiffDigest !== preview.diffDigest) {
    throw new CommandIntentError("conflict", "Diff changed after the preview");
  }
  if (observed.observedGateDigest !== preview.gateDigest) {
    throw new CommandIntentError("conflict", "Required quality gates changed after the preview");
  }
  if (!observed.observedGatesPassed || !preview.gatesPassed) {
    throw new CommandIntentError("conflict", "Required quality gates did not pass");
  }
}

/**
 * Local force-close of a mobile terminal session. Execution belongs to the
 * terminal supervisor: it revokes the lease by incrementing its generation and
 * terminates only the process tree it started, retaining the worktree.
 */
export type LocalForceCloseIntent = Readonly<{
  requestId: string;
  sessionId: string;
  reason: string;
  /** Fencing token: the session revision the operator saw. */
  expectedSessionRevision: number;
}>;

/**
 * Local revocation of a paired device. It invalidates the token family,
 * increments the device generation and revokes leases the device owned; it
 * deletes no repository and no worktree.
 */
export type LocalDeviceRevokeIntent = Readonly<{
  requestId: string;
  deviceId: string;
  reason: string;
}>;
