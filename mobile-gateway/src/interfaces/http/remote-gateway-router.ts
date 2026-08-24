import { randomUUID } from "node:crypto";
import {
  DeviceAuthError,
  DeviceAuthService,
  type AccessTokenClaims,
  type DeviceScope,
} from "../../application/device-auth-service.js";
import {
  GatewayRateLimits,
  type RateLimitedSurface,
} from "../../application/gateway-rate-limits.js";
import {
  GitHubReadError,
  type GitHubReadService,
} from "../../application/github-read-service.js";
import type { AuditAction, AuditEvent, AuditPort } from "../../application/ports/audit-port.js";
import type { ProjectMembershipPort } from "../../application/ports/project-membership-port.js";
import {
  ProjectReadError,
  type ProjectReadService,
} from "../../application/project-read-service.js";
import { TerminalSupervisor, TerminalSupervisorError } from "../../application/terminal-supervisor.js";
import { AgLoopReadRoutes, matchAgRead } from "./remote-gateway-ag-reads.js";
import {
  AuditWriteError,
  InvalidHttpRequestError,
  RateLimitedError,
  errorResponse,
  responseHeaders,
  type AuditDraft,
  type GatewayHttpRequest,
  type GatewayHttpResponse,
} from "./remote-gateway-contract.js";
import { UUID_PATTERN, pairingDto, refreshDto, tokenBody } from "./remote-gateway-dto.js";
import {
  TerminalRoutes,
  assertTerminalIds,
  matchCreateTerminal,
  matchTerminalRoute,
  terminalAuditAction,
} from "./remote-gateway-terminals.js";

/**
 * Nuotolinio šliuzo MARŠRUTIZATORIUS: eiliškumas, autentikacija, klaidų atvaizdavimas ir
 * auditas.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 1319 eilučių). Keturi
 * kaimynai laiko po vieną atsakomybę: `-contract` — žodyną ir vokus, `-dto` — teisėtas formas,
 * `-ag-reads` — AG Loop UI skaitymo šeimą su jos srautų biudžetu, `-terminals` — terminalo
 * seansus su jų idempotencijos ledger'iu. Čia lieka tik tai, kas sprendžia TVARKĄ: koks
 * maršrutas, ar skambintojas autentikuotas, kokiu kodu virsta išimtis ir kas patenka į auditą.
 *
 * Suderinamumas: `-contract` vardai reeksportuojami, nes etalone jie gyveno šiame faile, o
 * `src/index.ts` bei testai importuoja juos iš čia.
 */

export {
  GATEWAY_ERROR_CODES,
  GATEWAY_RECOVERABLE_BY_CODE,
  GATEWAY_ROUTE_SURFACE,
  GATEWAY_STATUS_BY_CODE,
  MAX_HTTP_BODY_BYTES,
  type GatewayErrorCode,
  type GatewayHttpRequest,
  type GatewayHttpResponse,
} from "./remote-gateway-contract.js";

export type RemoteGatewayRouterDependencies = Readonly<{
  deviceAuth: DeviceAuthService;
  now?: () => Date;
  projectReads?: ProjectReadService;
  /** GitHub reads; omitted compositions serve no GitHub route at all. */
  github?: GitHubReadService;
  terminals?: TerminalSupervisor;
  membership?: ProjectMembershipPort;
  /**
   * Required, not optional: `threat-model.md` protects audit integrity, and an
   * omitted sink would silently disable the append-only record for every
   * repudiable action. Compositions that genuinely want no durable log must say
   * so by passing an explicit in-memory store.
   */
  audit: AuditPort;
  /** Defaults to the standard pairing, refresh and terminal-mutation budgets. */
  rateLimits?: GatewayRateLimits;
}>;

function authError(
  error: DeviceAuthError,
  correlationId: string,
  action: AuditAction | undefined,
): GatewayHttpResponse {
  if (error.code === "pairing_expired" || error.code === "pairing_consumed") {
    return errorResponse("conflict", "Pairing challenge is unavailable", correlationId);
  }
  if (
    error.code === "invalid_pairing" ||
    (error.code === "invalid_device_proof" && action === "auth.pairing.redeem")
  ) {
    return errorResponse("invalid_request", "Authentication request is invalid", correlationId);
  }
  if (error.code === "insufficient_scope") {
    return errorResponse("forbidden", "Device scope does not allow this operation", correlationId);
  }
  return errorResponse("unauthenticated", "Device authentication failed", correlationId);
}

export class RemoteGatewayRouter {
  readonly #deviceAuth: DeviceAuthService;
  readonly #now: () => Date;
  readonly #projectReads: ProjectReadService | undefined;
  readonly #github: GitHubReadService | undefined;
  readonly #membership: ProjectMembershipPort | undefined;
  readonly #audit: AuditPort;
  readonly #rateLimits: GatewayRateLimits;
  readonly #agReads = new AgLoopReadRoutes();
  readonly #terminalRoutes: TerminalRoutes | undefined;

  constructor(dependencies: RemoteGatewayRouterDependencies) {
    this.#rateLimits = dependencies.rateLimits ?? new GatewayRateLimits();
    this.#deviceAuth = dependencies.deviceAuth;
    this.#now = dependencies.now ?? (() => new Date());
    this.#projectReads = dependencies.projectReads;
    this.#github = dependencies.github;
    this.#membership = dependencies.membership;
    this.#audit = dependencies.audit;
    this.#terminalRoutes = dependencies.terminals
      ? new TerminalRoutes({
        terminals: dependencies.terminals,
        rateLimits: this.#rateLimits,
        now: this.#now,
      })
      : undefined;
  }

  async #principal(request: GatewayHttpRequest, scope: DeviceScope): Promise<AccessTokenClaims> {
    const authorization = request.headers?.["authorization"];
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!match?.[1]) {
      throw new DeviceAuthError("invalid_access_token", "Bearer access token is required");
    }
    return this.#deviceAuth.authorizeAccessToken(match[1], scope, this.#now());
  }

  async #terminalPrincipal(
    request: GatewayHttpRequest,
    projectId: string,
    draft: AuditDraft,
  ): Promise<AccessTokenClaims> {
    const claims = await this.#principal(request, "terminal:write");
    draft.principalId = claims.sub;
    draft.deviceId = claims.deviceId;
    if (!this.#membership || !await this.#membership.canControlTerminal(claims.sub, projectId)) {
      throw new ProjectReadError("project_not_found", "Project is not visible");
    }
    return claims;
  }

  /**
   * Throttles an unauthenticated surface BEFORE any body is read, so a denied
   * caller never reaches JSON parsing or Ed25519 proof verification.
   */
  #enforceRateLimit(surface: RateLimitedSurface, key: string): void {
    const decision = this.#rateLimits.consume(surface, key, this.#now().getTime());
    if (!decision.allowed) {
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
  }

  async handle(request: GatewayHttpRequest): Promise<GatewayHttpResponse> {
    const correlationId = randomUUID();
    const draft: AuditDraft = {};
    let response: GatewayHttpResponse;
    try {
      response = await this.#route(request, correlationId, draft);
    } catch (error) {
      response = this.#errorFor(error, correlationId, draft);
    }
    try {
      await this.#recordAudit(draft, response, correlationId);
    } catch (error) {
      if (error instanceof AuditWriteError) {
        // An unaudited mutation is a repudiation failure, so the gateway fails
        // closed. The caller's Idempotency-Key plus the supervisor's own
        // identity ledgers make the retry side-effect free.
        return errorResponse("internal_error", "Internal gateway error", correlationId);
      }
      throw error;
    }
    return response;
  }

  #errorFor(error: unknown, correlationId: string, draft: AuditDraft): GatewayHttpResponse {
    if (error instanceof RateLimitedError) {
      return errorResponse(
        "rate_limited",
        "Too many attempts from this source",
        correlationId,
        { "retry-after": String(error.retryAfterSeconds) },
      );
    }
    // The only branch that echoes an error's own message, and it may stay that
    // way only because every `InvalidHttpRequestError` in this package is raised
    // with a gateway constant naming a field the gateway itself declares. An
    // upstream or host string must never be thrown as one: unlike the mappings
    // below, this branch has no chance to redact it.
    if (error instanceof InvalidHttpRequestError) {
      return errorResponse("invalid_request", error.message, correlationId);
    }
    if (error instanceof DeviceAuthError) {
      return authError(error, correlationId, draft.action);
    }
    if (error instanceof ProjectReadError) {
      if (error.code === "project_not_found") {
        return errorResponse("project_not_found", "Project not found", correlationId);
      }
      return errorResponse("ag_loop_ui_offline", "AG Loop UI is offline", correlationId);
    }
    if (error instanceof GitHubReadError) {
      if (error.code === "project_not_found") {
        return errorResponse("project_not_found", "Project not found", correlationId);
      }
      if (error.code === "repository_not_bound") {
        return errorResponse(
          "conflict",
          "Project is not bound to a GitHub repository",
          correlationId,
        );
      }
      // `internal_error` is a deliberate limitation, not a mis-mapping: the
      // contract's error enum is frozen, `ag_loop_ui_offline` belongs to the AG
      // Loop UI and `host_busy` to the terminal, so a host GitHub fault has no
      // more specific code to claim. It stays recoverable because retrying is
      // exactly what the client should do.
      return errorResponse("internal_error", "Internal gateway error", correlationId);
    }
    if (error instanceof TerminalSupervisorError) {
      if (error.code === "project_not_found") {
        return errorResponse("project_not_found", "Project not found", correlationId);
      }
      if (error.code === "host_busy") {
        return errorResponse("host_busy", "Another mobile terminal is active", correlationId);
      }
      if (error.code === "duplicate_request") {
        return errorResponse("duplicate_request", "Request id was reused", correlationId);
      }
      if (error.code === "stale_terminal_lease") {
        return errorResponse("stale_terminal_lease", "Terminal lease is stale", correlationId);
      }
      if (error.code === "session_not_live") {
        return errorResponse("session_not_live", "Terminal session is not live", correlationId);
      }
      return errorResponse("internal_error", "Terminal failed to start", correlationId);
    }
    return errorResponse("internal_error", "Internal gateway error", correlationId);
  }

  async #recordAudit(
    draft: AuditDraft,
    response: GatewayHttpResponse,
    correlationId: string,
  ): Promise<void> {
    if (!draft.action) {
      return;
    }
    const errorBody = response.body["error"] as { code?: string } | undefined;
    const event: AuditEvent = {
      eventId: randomUUID(),
      occurredAt: this.#now().toISOString(),
      action: draft.action,
      outcome: response.status < 400 ? "allowed" : response.status < 500 ? "denied" : "failed",
      correlationId,
      ...(draft.principalId ? { principalId: draft.principalId } : {}),
      ...(draft.deviceId ? { deviceId: draft.deviceId } : {}),
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
      ...(draft.requestId ? { requestId: draft.requestId } : {}),
      ...(response.status >= 400 && errorBody?.code ? { reasonCode: errorBody.code } : {}),
    };
    try {
      await this.#audit.record(event);
    } catch {
      throw new AuditWriteError("Audit record could not be written");
    }
  }

  /** No endpoint below the pairing surface accepts a query string. */
  #refuseQuery(url: URL): void {
    if (url.search !== "") {
      throw new InvalidHttpRequestError("Query parameters are not allowed on this endpoint");
    }
  }

  async #route(
    request: GatewayHttpRequest,
    correlationId: string,
    draft: AuditDraft,
  ): Promise<GatewayHttpResponse> {
    if (!request.path.startsWith("/") || request.path.startsWith("//")) {
      throw new InvalidHttpRequestError("Request target must use origin form");
    }
    const method = request.method.toUpperCase();
    const url = new URL(request.path, "https://gateway.invalid");

    const pairingMatch = /^\/v1\/pairing-challenges\/([^/]+)\/redeem$/.exec(url.pathname);
    if (method === "POST" && pairingMatch) {
      draft.action = "auth.pairing.redeem";
      this.#enforceRateLimit("pairing", request.remoteAddress ?? "unknown");
      this.#refuseQuery(url);
      const challengeId = pairingMatch[1];
      if (!challengeId || !UUID_PATTERN.test(challengeId)) {
        throw new InvalidHttpRequestError("Pairing challenge id is invalid");
      }
      const dto = pairingDto(request);
      const paired = await this.#deviceAuth.redeemPairingChallenge({
        challengeId,
        ...dto,
        now: this.#now(),
      });
      draft.principalId = paired.principalId;
      draft.deviceId = paired.deviceId;
      return {
        status: 200,
        headers: responseHeaders(),
        body: {
          deviceId: paired.deviceId,
          principalId: paired.principalId,
          hostFingerprint: paired.hostFingerprint,
          tokens: tokenBody(paired.tokens),
        },
      };
    }

    if (method === "POST" && url.pathname === "/v1/auth/refresh") {
      draft.action = "auth.refresh";
      this.#enforceRateLimit("refresh", request.remoteAddress ?? "unknown");
      this.#refuseQuery(url);
      const dto = refreshDto(request);
      draft.deviceId = dto.deviceId;
      const tokens = await this.#deviceAuth.refresh({ ...dto, now: this.#now() });
      return { status: 200, headers: responseHeaders(), body: tokenBody(tokens) };
    }

    if (method === "GET" && url.pathname === "/v1/connections/github" && this.#github) {
      this.#refuseQuery(url);
      // Throttled per device before the read runs: a GitHub read costs host
      // processes, so a valid access token must not be an unbounded one.
      const claims = await this.#principal(request, "github:read");
      this.#enforceRateLimit("github-read", claims.deviceId);
      return {
        status: 200,
        headers: responseHeaders(),
        body: await this.#github.connection(),
      };
    }

    if (method === "GET" && url.pathname === "/v1/projects" && this.#projectReads) {
      this.#refuseQuery(url);
      const principalId = (await this.#principal(request, "ag:read")).sub;
      return {
        status: 200,
        headers: responseHeaders(),
        body: { projects: await this.#projectReads.list(principalId) },
      };
    }

    // Read-only by construction: the AG Loop UI family is matched for `GET`
    // only, so every mutation verb on every AG path falls through to the 404
    // below instead of reaching a handler that would have to refuse it.
    const agRead = matchAgRead(url.pathname);
    if (method === "GET" && agRead && this.#projectReads) {
      if (!UUID_PATTERN.test(agRead.projectId)) {
        throw new InvalidHttpRequestError("Project id is invalid");
      }
      const claims = await this.#principal(request, "ag:read");
      return this.#agReads.read(this.#projectReads, url, agRead.resource, agRead.projectId, claims);
    }

    // Declared before the terminal matchers and anchored on `/github`, so it can
    // never shadow — or be shadowed by — a terminal session path.
    const githubStatusMatch = /^\/v1\/projects\/([^/]+)\/github$/.exec(url.pathname);
    if (method === "GET" && githubStatusMatch && this.#github) {
      this.#refuseQuery(url);
      const projectId = githubStatusMatch[1];
      if (!projectId || !UUID_PATTERN.test(projectId)) {
        throw new InvalidHttpRequestError("Project id is invalid");
      }
      const claims = await this.#principal(request, "github:read");
      this.#enforceRateLimit("github-read", claims.deviceId);
      // Project visibility is decided by the read service, as for every other
      // project read: the interface layer authenticates and budgets, the
      // application layer authorizes.
      return {
        status: 200,
        headers: responseHeaders(),
        body: await this.#github.projectStatus(claims.sub, projectId),
      };
    }

    const createProjectId = matchCreateTerminal(url.pathname);
    if (method === "POST" && createProjectId !== undefined && this.#terminalRoutes) {
      draft.action = "terminal.session.create";
      this.#refuseQuery(url);
      if (!UUID_PATTERN.test(createProjectId)) {
        throw new InvalidHttpRequestError("Project id is invalid");
      }
      draft.projectId = createProjectId;
      // Authenticate and authorize before reading the body: an anonymous caller
      // must not be able to use DTO validation as an oracle for the request
      // shape, nor make the host parse untrusted JSON on its behalf.
      const claims = await this.#terminalPrincipal(request, createProjectId, draft);
      return await this.#terminalRoutes.create(request, createProjectId, claims, draft);
    }

    const terminal = matchTerminalRoute(url.pathname);
    if (terminal && this.#terminalRoutes) {
      this.#refuseQuery(url);
      assertTerminalIds(terminal.projectId, terminal.sessionId);
      if (terminal.action) {
        draft.action = terminalAuditAction(terminal.action);
      }
      draft.projectId = terminal.projectId;
      draft.sessionId = terminal.sessionId;
      const claims = await this.#terminalPrincipal(request, terminal.projectId, draft);
      return await this.#terminalRoutes.session(request, method, terminal, claims, draft, correlationId);
    }

    return errorResponse("not_found", "Route not found", correlationId);
  }
}
