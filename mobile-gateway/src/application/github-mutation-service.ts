import { CommandIntentError, type AnyCommandIntent } from "../domain/command-intent.js";
import {
  type ApprovedCommand,
  type CommandApprovalService,
  type CommandExecution,
  type CommandPrincipal,
  type CommandSubmission,
} from "./command-approval-service.js";
import type { GitHubConnectionDto, GitHubReadService } from "./github-read-service.js";
import type { GitHostConnection, GitHostPort } from "./ports/git-host-port.js";

/**
 * GitHub mutations, and the proof that none of them can run unapproved.
 *
 * `spec.md` keeps GitHub authorization on the host — "ilgalaikiai credential'ai
 * negali būti grąžinami mobile klientui" — and `design.md` §11 classifies both
 * connection mutations as `confirm` risk. Those two facts meet here: every
 * method below is a call into {@link CommandApprovalService.execute}, so the
 * port is reached only from inside an accepted decision, and the answer a
 * client gets is the decision first and the connection state second.
 *
 * What this service deliberately does NOT do is resolve repositories, sessions
 * or branches. Pull request creation needs all three, and its use case belongs
 * with the rest of the GitHub read/write use cases; the gate it has to pass
 * through is `gitHostWriteContext`, which cannot be called without an
 * {@link ApprovedCommand}. Adding that use case later therefore cannot skip
 * approval — not by discipline, but because the write context has no other
 * construction site.
 */

export type GitHubMutationDependencies = Readonly<{
  gitHost: GitHostPort;
  approvals: CommandApprovalService;
  /**
   * The read model whose cached connection answer this service invalidates.
   * Optional: a composition that serves no GitHub read route has no cache to
   * keep honest.
   */
  reads?: GitHubReadService;
}>;

/** Sanitized projection, identical in shape to the read model's. */
function connectionDto(connection: GitHostConnection): GitHubConnectionDto {
  return Object.freeze({
    status: connection.status,
    ...(connection.account === undefined ? {} : { account: connection.account }),
    ...(connection.authorizationUrl === undefined
      ? {}
      : { authorizationUrl: connection.authorizationUrl }),
  });
}

export class GitHubMutationService {
  private readonly gitHost: GitHostPort;
  private readonly approvals: CommandApprovalService;
  // `| undefined`, ne `?`: laukas priskiriamas besąlygiškai iš neprivalomos priklausomybės, o
  // `exactOptionalPropertyTypes` opcionalaus lauko su eksplicitiniu `undefined` nepriima.
  private readonly reads: GitHubReadService | undefined;

  constructor(dependencies: GitHubMutationDependencies) {
    this.gitHost = dependencies.gitHost;
    this.approvals = dependencies.approvals;
    this.reads = dependencies.reads;
  }

  /**
   * Starts host-side GitHub authorization.
   *
   * The authorization URL is the only thing a client ever sees from this flow;
   * `connectionId`, the expiry and any host reason code stay behind the
   * projection, exactly as they do on the read path.
   */
  async beginConnection(
    intent: AnyCommandIntent,
    principal: CommandPrincipal,
    submission: Pick<CommandSubmission, "approval" | "correlationId"> = {},
  ): Promise<CommandExecution<GitHubConnectionDto>> {
    this.assertAction(intent, "github.connection.begin");
    return this.approvals.execute<GitHubConnectionDto>(
      { intent, principal, ...submission },
      async (approved: ApprovedCommand) => {
        const connection = await this.gitHost.beginAuthorization({
          // The accepted command id IS the request id: a retried authorization
          // must not start a second flow, and the ledger already guarantees one
          // accepted command per idempotency key.
          requestId: approved.commandId,
        });
        this.reads?.invalidateConnection();
        return connectionDto(connection);
      },
    );
  }

  /** Revokes the host-held authorization. The local repository is untouched. */
  async revokeConnection(
    intent: AnyCommandIntent,
    principal: CommandPrincipal,
    submission: Pick<CommandSubmission, "approval" | "correlationId"> = {},
  ): Promise<CommandExecution<void>> {
    this.assertAction(intent, "github.connection.revoke");
    return this.approvals.execute<void>(
      { intent, principal, ...submission },
      async (approved: ApprovedCommand) => {
        await this.gitHost.revokeConnection({ requestId: approved.commandId });
        this.reads?.invalidateConnection();
      },
    );
  }

  /**
   * A method may only be handed the intent it implements. Without this an
   * approval shown for one action could be spent on another that happens to
   * share the same risk class.
   */
  private assertAction(intent: AnyCommandIntent, expected: AnyCommandIntent["action"]): void {
    if (intent.action !== expected) {
      throw new CommandIntentError("invalid_request", `Command action must be ${expected}`);
    }
  }
}
