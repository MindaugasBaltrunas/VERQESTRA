import { createHash } from "node:crypto";
import type { AccessTokenClaims } from "../../application/device-auth-service.js";
import type { GatewayRateLimits } from "../../application/gateway-rate-limits.js";
import type { AuditAction } from "../../application/ports/audit-port.js";
import {
  TerminalSupervisor,
  TerminalSupervisorError,
} from "../../application/terminal-supervisor.js";
import {
  InvalidHttpRequestError,
  RateLimitedError,
  errorResponse,
  responseHeaders,
  type AuditDraft,
  type GatewayHttpRequest,
  type GatewayHttpResponse,
} from "./remote-gateway-contract.js";
import {
  UUID_PATTERN,
  createTerminalSessionDto,
  idempotencyKey,
  integerField,
  jsonObject,
  leaseFence,
  terminalInputDto,
} from "./remote-gateway-dto.js";

/**
 * Terminalo seansų MARŠRUTAI ir jų idempotencijos ledger'is.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas). Pjūvis ne mechaninis: `terminalMutations` yra
 * vienintelė būsena, kurią liečia tik šie maršrutai, tad ji keliauja kartu su jais.
 *
 * Kviečiantysis (`RemoteGatewayRouter`) atsako už kelio atpažinimą, `draft` užpildymą ir
 * autentikaciją; šis failas — už įrenginio kvotą, idempotenciją ir patį vykdymą. Tokia riba
 * yra ta pati, kuri buvo etalone: autentikacija VISADA įvyksta prieš kūno skaitymą.
 *
 * NUKRYPIMAS (griežtinantis): etalone kiekvienas kvietimas buvo `this.terminals!` — supervizorius
 * ten yra opcionalus laukas, o `!` teigė tai, ką patikrino kelias eilučių aukščiau esantis `if`.
 * Čia supervizorius yra privalomas konstruktoriaus argumentas, tad nė vieno `!` nebeliko.
 */

const TERMINAL_MUTATION_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_MUTATION_RECORDS = 4096;

/**
 * One matcher for every terminal action, so this alternation stays the single
 * place in which all of them are named. A two-segment `lease/renew` would
 * have cost exactly that property.
 */
const TERMINAL_ROUTE =
  /^\/v1\/projects\/([^/]+)\/terminal-sessions\/([^/]+)(?:\/(input|resize|signal|close|lease))?$/;

const CREATE_TERMINAL_ROUTE = /^\/v1\/projects\/([^/]+)\/terminal-sessions$/;

/**
 * The audit action each terminal path segment names.
 *
 * A frozen map rather than the if/else chain this used to be: `satisfies
 * Record<TerminalAction, AuditAction>` makes both a mistyped action and a segment with no
 * action a compile error.
 */
const TERMINAL_AUDIT_ACTIONS = Object.freeze({
  input: "terminal.input",
  resize: "terminal.resize",
  signal: "terminal.signal",
  close: "terminal.close",
  lease: "terminal.lease.renew",
} as const satisfies Record<string, AuditAction>);

export type TerminalAction = keyof typeof TERMINAL_AUDIT_ACTIONS;

/** The terminal operation a request target names; ids are still unvalidated. */
export type TerminalTarget = Readonly<{
  projectId: string;
  sessionId: string;
  /** Absent for the session read, which is the bare session path. */
  action?: TerminalAction;
}>;

function terminalAction(value: string): TerminalAction | undefined {
  return (Object.keys(TERMINAL_AUDIT_ACTIONS) as readonly TerminalAction[])
    .find((candidate) => candidate === value);
}

/** The audit action a terminal segment records, for a draft filled before admission. */
export function terminalAuditAction(action: TerminalAction): AuditAction {
  return TERMINAL_AUDIT_ACTIONS[action];
}

/** Raw project id of a session-create path, or `undefined` when the path is another one. */
export function matchCreateTerminal(pathname: string): string | undefined {
  const match = CREATE_TERMINAL_ROUTE.exec(pathname);
  return match?.[1];
}

/**
 * Which terminal operation a path names, or `undefined` when it names none.
 *
 * NUKRYPIMAS (formos, ne elgesio): `noUncheckedIndexedAccess` daro regex grupes
 * `string | undefined`. Pirmos dvi grupės yra privalomos, trečia — tikrai opcionali, tad ji
 * praleidžiama per sąlyginį spread'ą (`exactOptionalPropertyTypes`).
 */
export function matchTerminalRoute(pathname: string): TerminalTarget | undefined {
  const match = TERMINAL_ROUTE.exec(pathname);
  if (!match) return undefined;
  const [, projectId, sessionId, segment] = match;
  if (projectId === undefined || sessionId === undefined) return undefined;
  if (segment === undefined) {
    return Object.freeze({ projectId, sessionId });
  }
  const action = terminalAction(segment);
  if (action === undefined) return undefined;
  return Object.freeze({ projectId, sessionId, action });
}

/** Both ids of a terminal path must be UUIDs before any of them reaches the supervisor. */
export function assertTerminalIds(projectId: string, sessionId: string): void {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(sessionId)) {
    throw new InvalidHttpRequestError("Project or terminal session id is invalid");
  }
}

export type TerminalRoutesDependencies = Readonly<{
  terminals: TerminalSupervisor;
  rateLimits: GatewayRateLimits;
  now: () => Date;
}>;

export class TerminalRoutes {
  readonly #mutations = new Map<string, {
    fingerprint: string;
    createdAtMs: number;
    result: Promise<GatewayHttpResponse>;
  }>();

  readonly #terminals: TerminalSupervisor;
  readonly #rateLimits: GatewayRateLimits;
  readonly #now: () => Date;

  constructor(dependencies: TerminalRoutesDependencies) {
    this.#terminals = dependencies.terminals;
    this.#rateLimits = dependencies.rateLimits;
    this.#now = dependencies.now;
  }

  /**
   * Bounds authenticated terminal mutations per device. A valid access token is
   * not a DoS control on its own: a compromised paired device would otherwise
   * drive input, resize and signal calls without limit.
   */
  #enforceDeviceQuota(deviceId: string): void {
    const decision = this.#rateLimits.consume("terminal-mutation", deviceId, this.#now().getTime());
    if (!decision.allowed) {
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
  }

  #mutation(
    deviceId: string,
    key: string,
    fingerprint: string,
    operation: () => Promise<GatewayHttpResponse>,
  ): Promise<GatewayHttpResponse> {
    const ledgerKey = `${deviceId}:${key}`;
    const fingerprintHash = createHash("sha256").update(fingerprint, "utf8").digest("base64url");
    const existing = this.#mutations.get(ledgerKey);
    if (existing) {
      if (existing.fingerprint !== fingerprintHash) {
        throw new TerminalSupervisorError(
          "duplicate_request",
          "Idempotency key was reused for another terminal mutation",
        );
      }
      return existing.result;
    }
    const nowMs = this.#now().getTime();
    for (const [candidateKey, record] of this.#mutations) {
      if (nowMs - record.createdAtMs >= TERMINAL_MUTATION_LEDGER_TTL_MS) {
        this.#mutations.delete(candidateKey);
      }
    }
    if (this.#mutations.size >= MAX_TERMINAL_MUTATION_RECORDS) {
      throw new TerminalSupervisorError("host_busy", "Terminal mutation ledger is full");
    }
    const result = operation();
    this.#mutations.set(ledgerKey, {
      fingerprint: fingerprintHash,
      createdAtMs: nowMs,
      result,
    });
    // A rejected mutation committed no result, so replaying the failure would
    // strand a client that retries with the same key. The slot is released and
    // re-execution stays safe because the supervisor keeps its own
    // create/input identity ledger.
    result.catch(() => {
      const current = this.#mutations.get(ledgerKey);
      if (current?.result === result) {
        this.#mutations.delete(ledgerKey);
      }
    });
    return result;
  }

  /**
   * Creates a session. The caller has already authenticated and authorized: the body is read
   * only here, so an anonymous caller can never use DTO validation as an oracle for the
   * request shape, nor make the host parse untrusted JSON on its behalf.
   */
  async create(
    request: GatewayHttpRequest,
    projectId: string,
    claims: AccessTokenClaims,
    draft: AuditDraft,
  ): Promise<GatewayHttpResponse> {
    this.#enforceDeviceQuota(claims.deviceId);
    const requestId = idempotencyKey(request);
    const dto = createTerminalSessionDto(request);
    const created = await this.#mutation(
      claims.deviceId,
      requestId,
      `create:${projectId}:${dto.provider}:${dto.workspaceMode}:${dto.cols}:${dto.rows}`,
      async () => ({
        status: 201,
        headers: responseHeaders(),
        body: await this.#terminals.createSession({
          projectId,
          ownerDeviceId: claims.deviceId,
          requestId,
          ...dto,
        }),
      }),
    );
    // Read back from the response so a replayed create audits the same
    // session identity as the original call.
    const createdSessionId = created.body["sessionId"];
    if (typeof createdSessionId === "string") {
      draft.sessionId = createdSessionId;
    }
    return created;
  }

  /** Serves the session read and every session mutation. */
  async session(
    request: GatewayHttpRequest,
    method: string,
    target: TerminalTarget,
    claims: AccessTokenClaims,
    draft: AuditDraft,
    correlationId: string,
  ): Promise<GatewayHttpResponse> {
    const { projectId, sessionId, action } = target;
    if (method === "GET" && !action) {
      return {
        status: 200,
        headers: responseHeaders(),
        body: await this.#terminals.getSession(projectId, sessionId),
      };
    }
    if (method !== "POST" || !action) {
      return errorResponse("not_found", "Route not found", correlationId);
    }
    this.#enforceDeviceQuota(claims.deviceId);
    const mutationKey = idempotencyKey(request);
    if (action === "input") {
      return await this.#input(request, projectId, sessionId, claims, draft, mutationKey);
    }
    const value = jsonObject(request);
    if (action === "resize") {
      return await this.#resize(value, projectId, sessionId, claims, draft, mutationKey);
    }
    if (action === "signal") {
      return await this.#signal(value, projectId, sessionId, claims, draft, mutationKey);
    }
    if (action === "lease") {
      return await this.#lease(value, projectId, sessionId, claims, draft, mutationKey);
    }
    return await this.#close(value, projectId, sessionId, claims, draft, mutationKey);
  }

  async #input(
    request: GatewayHttpRequest,
    projectId: string,
    sessionId: string,
    claims: AccessTokenClaims,
    draft: AuditDraft,
    mutationKey: string,
  ): Promise<GatewayHttpResponse> {
    const dto = terminalInputDto(request);
    draft.requestId = dto.requestId;
    return await this.#mutation(
      claims.deviceId,
      mutationKey,
      `input:${projectId}:${sessionId}:${dto.requestId}:${dto.leaseId}:${dto.leaseGeneration}:${dto.inputId}:${dto.source}:${dto.text}`,
      async () => ({
        status: 202,
        headers: responseHeaders(),
        body: await this.#terminals.writeInput({
          projectId,
          sessionId,
          ownerDeviceId: claims.deviceId,
          ...dto,
        }),
      }),
    );
  }

  async #resize(
    value: Record<string, unknown>,
    projectId: string,
    sessionId: string,
    claims: AccessTokenClaims,
    draft: AuditDraft,
    mutationKey: string,
  ): Promise<GatewayHttpResponse> {
    const fence = leaseFence(value, ["requestId", "leaseId", "leaseGeneration", "cols", "rows"]);
    draft.requestId = fence.requestId;
    const cols = integerField(value["cols"], "cols", 20, 500);
    const rows = integerField(value["rows"], "rows", 5, 300);
    return await this.#mutation(
      claims.deviceId,
      mutationKey,
      `resize:${projectId}:${sessionId}:${fence.requestId}:${fence.leaseId}:${fence.leaseGeneration}:${cols}:${rows}`,
      async () => {
        await this.#terminals.resize({
          projectId,
          sessionId,
          ownerDeviceId: claims.deviceId,
          ...fence,
          cols,
          rows,
        });
        return { status: 204, headers: responseHeaders(), body: {} };
      },
    );
  }

  async #signal(
    value: Record<string, unknown>,
    projectId: string,
    sessionId: string,
    claims: AccessTokenClaims,
    draft: AuditDraft,
    mutationKey: string,
  ): Promise<GatewayHttpResponse> {
    const fence = leaseFence(value, ["requestId", "leaseId", "leaseGeneration", "signal"]);
    draft.requestId = fence.requestId;
    const signal = value["signal"];
    if (signal !== "interrupt" && signal !== "terminate") {
      throw new InvalidHttpRequestError("Terminal signal is invalid");
    }
    return await this.#mutation(
      claims.deviceId,
      mutationKey,
      `signal:${projectId}:${sessionId}:${fence.requestId}:${fence.leaseId}:${fence.leaseGeneration}:${signal}`,
      async () => {
        if (signal === "interrupt") {
          await this.#terminals.interrupt({
            projectId,
            sessionId,
            ownerDeviceId: claims.deviceId,
            ...fence,
          });
          return { status: 202, headers: responseHeaders(), body: {} };
        }
        return {
          status: 202,
          headers: responseHeaders(),
          body: await this.#terminals.terminate({
            projectId,
            sessionId,
            ownerDeviceId: claims.deviceId,
            ...fence,
          }),
        };
      },
    );
  }

  /**
   * The renewal request IS the fence and nothing more: no client-proposed
   * TTL, because the lifetime of write access to a host PTY is the host's
   * security parameter. Replaying the same Idempotency-Key returns the same
   * `expiresAt` rather than extending again, so a retry can never silently
   * double the deadline; a genuine second renewal carries a new key.
   */
  async #lease(
    value: Record<string, unknown>,
    projectId: string,
    sessionId: string,
    claims: AccessTokenClaims,
    draft: AuditDraft,
    mutationKey: string,
  ): Promise<GatewayHttpResponse> {
    const fence = leaseFence(value, ["requestId", "leaseId", "leaseGeneration"]);
    draft.requestId = fence.requestId;
    return await this.#mutation(
      claims.deviceId,
      mutationKey,
      `lease:${projectId}:${sessionId}:${fence.requestId}:${fence.leaseId}:${fence.leaseGeneration}`,
      async () => ({
        status: 200,
        headers: responseHeaders(),
        body: await this.#terminals.renewLease({
          projectId,
          sessionId,
          ownerDeviceId: claims.deviceId,
          ...fence,
        }),
      }),
    );
  }

  async #close(
    value: Record<string, unknown>,
    projectId: string,
    sessionId: string,
    claims: AccessTokenClaims,
    draft: AuditDraft,
    mutationKey: string,
  ): Promise<GatewayHttpResponse> {
    const fence = leaseFence(value, ["requestId", "leaseId", "leaseGeneration"]);
    draft.requestId = fence.requestId;
    return await this.#mutation(
      claims.deviceId,
      mutationKey,
      `close:${projectId}:${sessionId}:${fence.requestId}:${fence.leaseId}:${fence.leaseGeneration}`,
      async () => ({
        status: 202,
        headers: responseHeaders(),
        body: await this.#terminals.close({
          projectId,
          sessionId,
          ownerDeviceId: claims.deviceId,
          ...fence,
        }),
      }),
    );
  }
}
