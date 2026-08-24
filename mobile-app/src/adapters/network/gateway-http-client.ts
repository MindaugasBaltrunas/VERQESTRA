import type {
  CredentialPort,
  DeviceCredential,
  DeviceProofPort,
  GatewayPort,
  TerminalLease,
  TerminalSession,
} from "../../model/ports.js";
import {
  ACCESS_TOKEN_PATTERN,
  exactKeys,
  GATEWAY_BASE_URL_PATTERN,
  isDateTime,
  isOneOf,
  isRecord,
  isSafeInteger,
  isValidDeviceCredential,
  NONCE_PATTERN,
  OPAQUE_TOKEN_PATTERN,
  parseJson,
  PROOF_PATTERN,
  UUID_PATTERN,
  type JsonRecord,
} from "../shared/gateway-format.js";

/**
 * NUKRYPIMAS (forma, ne elgesys, visame faile): `noPropertyAccessFromIndexSignature` draudžia
 * `value.leaseId` ant `Record<string, unknown>`, tad kiekviena tokia prieiga rašoma laužtiniais.
 * Kartu dingo visi `as number` / `as TerminalSession["state"]` tvirtinimai — juos pakeitė
 * `isSafeInteger` ir `isOneOf` predikatai iš `gateway-format.ts`. Priimamų atsakymų aibė
 * nepakito nė per vieną lauką.
 */

export interface MobileHttpTransportPort {
  request(input: Readonly<{
    method: "GET" | "POST";
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
  }>): Promise<Readonly<{
    status: number;
    body: string;
  }>>;
}

export interface MobileIdPort {
  nextUuid(): string;
}

export class GatewayClientError extends Error {
  constructor(
    readonly code:
      | "not_paired"
      | "authentication_failed"
      | "invalid_response"
      | "gateway_rejected"
      | "transport_failed",
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

const SESSION_STATES: readonly TerminalSession["state"][] = Object.freeze([
  "creating",
  "starting",
  "live",
  "interrupting",
  "closing",
  "ended",
  "failed",
  "orphaned",
] as const);

const INPUT_STATUSES: readonly ("accepted" | "written" | "rejected" | "unknown")[] = Object.freeze([
  "accepted",
  "written",
  "rejected",
  "unknown",
] as const);

function parseLease(value: unknown): TerminalLease | undefined {
  if (!isRecord(value) || !exactKeys(value, ["leaseId", "ownerDeviceId", "generation", "expiresAt"])) {
    return undefined;
  }
  const generation = value["generation"];
  const expiresAt = value["expiresAt"];
  if (
    !UUID_PATTERN.test(String(value["leaseId"])) ||
    !UUID_PATTERN.test(String(value["ownerDeviceId"])) ||
    !isSafeInteger(generation) ||
    generation < 1 ||
    !isDateTime(expiresAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    leaseId: String(value["leaseId"]),
    ownerDeviceId: String(value["ownerDeviceId"]),
    generation,
    expiresAt,
  });
}

function parseSession(value: JsonRecord): TerminalSession | undefined {
  if (
    !exactKeys(value, [
      "sessionId",
      "projectId",
      "provider",
      "workspaceMode",
      "branch",
      "state",
      "lease",
      "nextSequence",
    ])
  ) {
    return undefined;
  }
  const provider = value["provider"];
  const branch = value["branch"];
  const state = value["state"];
  const nextSequence = value["nextSequence"];
  if (
    !UUID_PATTERN.test(String(value["sessionId"])) ||
    !UUID_PATTERN.test(String(value["projectId"])) ||
    (provider !== "claude-code" && provider !== "codex") ||
    value["workspaceMode"] !== "isolated-worktree" ||
    typeof branch !== "string" ||
    branch.length === 0 ||
    !isOneOf(state, SESSION_STATES) ||
    !isSafeInteger(nextSequence) ||
    nextSequence < 1
  ) {
    return undefined;
  }
  const lease = parseLease(value["lease"]);
  if (!lease) return undefined;
  return Object.freeze({
    sessionId: String(value["sessionId"]),
    projectId: String(value["projectId"]),
    provider,
    workspaceMode: "isolated-worktree",
    branch,
    state,
    lease,
    nextSequence,
  });
}

function parseCredential(value: JsonRecord, previous: DeviceCredential): DeviceCredential | undefined {
  const accessToken = value["accessToken"];
  const accessExpiresAt = value["accessExpiresAt"];
  const refreshToken = value["refreshToken"];
  const refreshExpiresAt = value["refreshExpiresAt"];
  if (
    !exactKeys(value, [
      "accessToken",
      "accessExpiresAt",
      "refreshToken",
      "refreshExpiresAt",
    ]) ||
    typeof accessToken !== "string" ||
    !ACCESS_TOKEN_PATTERN.test(accessToken) ||
    !isDateTime(accessExpiresAt) ||
    typeof refreshToken !== "string" ||
    !OPAQUE_TOKEN_PATTERN.test(refreshToken) ||
    !isDateTime(refreshExpiresAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    deviceId: previous.deviceId,
    generation: previous.generation,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  });
}

function errorFromResponse(status: number, body: string): GatewayClientError {
  const parsed = parseJson(body);
  const error = parsed && isRecord(parsed["error"]) ? parsed["error"] : undefined;
  const recoverable = error?.["recoverable"] === true;
  if (status === 401 || status === 403) {
    return new GatewayClientError(
      "authentication_failed",
      "Gateway authentication failed",
      false,
    );
  }
  return new GatewayClientError(
    "gateway_rejected",
    "Gateway rejected the terminal request",
    recoverable,
  );
}

export class GatewayHttpClient implements GatewayPort {
  private refreshInFlight: Promise<DeviceCredential> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly transport: MobileHttpTransportPort,
    private readonly credentials: CredentialPort,
    private readonly proofs: DeviceProofPort,
    private readonly ids: MobileIdPort,
  ) {
    if (!GATEWAY_BASE_URL_PATTERN.test(baseUrl)) {
      throw new GatewayClientError(
        "invalid_response",
        "Secure gateway URL is invalid",
        false,
      );
    }
  }

  async createTerminalSession(input: Parameters<GatewayPort["createTerminalSession"]>[0]): Promise<TerminalSession> {
    const value = await this.request("POST", `/projects/${input.projectId}/terminal-sessions`, {
      provider: input.provider,
      workspaceMode: input.workspaceMode,
      cols: input.cols,
      rows: input.rows,
    }, [201], this.idempotencyKey());
    return this.requireSession(value);
  }

  async getTerminalSession(input: Parameters<GatewayPort["getTerminalSession"]>[0]): Promise<TerminalSession> {
    return this.requireSession(await this.request(
      "GET",
      `/projects/${input.projectId}/terminal-sessions/${input.sessionId}`,
      undefined,
      [200],
    ));
  }

  async writeTerminalInput(input: Parameters<GatewayPort["writeTerminalInput"]>[0]): Promise<Readonly<{
    inputId: string;
    status: "accepted" | "written" | "rejected" | "unknown";
  }>> {
    const inputId = this.uuid();
    const value = await this.request(
      "POST",
      `/projects/${input.projectId}/terminal-sessions/${input.sessionId}/input`,
      {
        ...this.fence(input.lease),
        inputId,
        source: input.source,
        text: input.text,
      },
      [202],
      this.idempotencyKey(),
    );
    const status = value["status"];
    if (
      !exactKeys(value, ["inputId", "status"]) ||
      value["inputId"] !== inputId ||
      !isOneOf(status, INPUT_STATUSES)
    ) {
      throw new GatewayClientError("invalid_response", "Terminal input response is invalid", false);
    }
    return Object.freeze({ inputId, status });
  }

  async resizeTerminal(input: Parameters<GatewayPort["resizeTerminal"]>[0]): Promise<void> {
    await this.request(
      "POST",
      `/projects/${input.projectId}/terminal-sessions/${input.sessionId}/resize`,
      { ...this.fence(input.lease), cols: input.cols, rows: input.rows },
      [204],
      this.idempotencyKey(),
    );
  }

  async signalTerminal(input: Parameters<GatewayPort["signalTerminal"]>[0]): Promise<TerminalSession | undefined> {
    const value = await this.request(
      "POST",
      `/projects/${input.projectId}/terminal-sessions/${input.sessionId}/signal`,
      { ...this.fence(input.lease), signal: input.signal },
      [202],
      this.idempotencyKey(),
    );
    if (Object.keys(value).length === 0) return undefined;
    return this.requireSession(value);
  }

  async closeTerminal(input: Parameters<GatewayPort["closeTerminal"]>[0]): Promise<TerminalSession> {
    return this.requireSession(await this.request(
      "POST",
      `/projects/${input.projectId}/terminal-sessions/${input.sessionId}/close`,
      this.fence(input.lease),
      [202],
      this.idempotencyKey(),
    ));
  }

  private fence(lease: TerminalLease): Readonly<{
    requestId: string;
    leaseId: string;
    leaseGeneration: number;
  }> {
    return Object.freeze({
      requestId: this.uuid(),
      leaseId: lease.leaseId,
      leaseGeneration: lease.generation,
    });
  }

  private idempotencyKey(): string {
    return `mobile-${this.uuid()}`;
  }

  private uuid(): string {
    const value = this.ids.nextUuid();
    if (!UUID_PATTERN.test(value)) {
      throw new GatewayClientError("invalid_response", "Mobile UUID source is invalid", false);
    }
    return value;
  }

  private requireSession(value: JsonRecord): TerminalSession {
    const session = parseSession(value);
    if (!session) {
      throw new GatewayClientError("invalid_response", "Terminal session response is invalid", false);
    }
    return session;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: JsonRecord | undefined,
    expectedStatuses: readonly number[],
    idempotencyKey?: string,
  ): Promise<JsonRecord> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) {
      throw new GatewayClientError("invalid_response", "Gateway request path is invalid", false);
    }
    const credential = await this.credentials.loadDeviceCredential();
    if (!credential) {
      throw new GatewayClientError("not_paired", "Device is not paired", false);
    }
    if (!isValidDeviceCredential(credential)) {
      throw new GatewayClientError(
        "authentication_failed",
        "Stored device credential is invalid",
        false,
      );
    }
    const first = await this.send(method, path, body, credential.accessToken, idempotencyKey);
    if (first.status !== 401) {
      return this.parseExpected(first.status, first.body, expectedStatuses);
    }
    const refreshed = await this.refreshCredential(credential);
    const retried = await this.send(method, path, body, refreshed.accessToken, idempotencyKey);
    return this.parseExpected(retried.status, retried.body, expectedStatuses);
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body: JsonRecord | undefined,
    accessToken: string,
    idempotencyKey?: string,
  ): Promise<Readonly<{ status: number; body: string }>> {
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    };
    if (body) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    try {
      return await this.transport.request({
        method,
        url: `${this.baseUrl}${path}`,
        headers: Object.freeze(headers),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new GatewayClientError("transport_failed", "Gateway transport failed", true);
    }
  }

  private parseExpected(
    status: number,
    body: string,
    expectedStatuses: readonly number[],
  ): JsonRecord {
    if (!expectedStatuses.includes(status)) throw errorFromResponse(status, body);
    if (status === 204 && body.length === 0) return {};
    const parsed = parseJson(body);
    if (!parsed) {
      throw new GatewayClientError("invalid_response", "Gateway response is invalid", false);
    }
    return parsed;
  }

  private refreshCredential(stale: DeviceCredential): Promise<DeviceCredential> {
    this.refreshInFlight ??= this.performRefresh(stale).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(stale: DeviceCredential): Promise<DeviceCredential> {
    const current = await this.credentials.loadDeviceCredential();
    if (!current) {
      throw new GatewayClientError("not_paired", "Device is not paired", false);
    }
    if (!isValidDeviceCredential(current)) {
      throw new GatewayClientError(
        "authentication_failed",
        "Stored device credential is invalid",
        false,
      );
    }
    if (current.accessToken !== stale.accessToken) return current;
    let signed: Readonly<{ nonce: string; proof: string }>;
    try {
      signed = await this.proofs.createRefreshProof({
        deviceId: current.deviceId,
        generation: current.generation,
        refreshToken: current.refreshToken,
      });
    } catch {
      throw new GatewayClientError("authentication_failed", "Device proof failed", false);
    }
    if (!NONCE_PATTERN.test(signed.nonce) || !PROOF_PATTERN.test(signed.proof)) {
      throw new GatewayClientError("authentication_failed", "Device proof is invalid", false);
    }
    let response: Readonly<{ status: number; body: string }>;
    try {
      response = await this.transport.request({
        method: "POST",
        url: `${this.baseUrl}/auth/refresh`,
        headers: Object.freeze({
          "Accept": "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          deviceId: current.deviceId,
          refreshToken: current.refreshToken,
          nonce: signed.nonce,
          proof: signed.proof,
        }),
      });
    } catch {
      throw new GatewayClientError("transport_failed", "Credential refresh transport failed", true);
    }
    if (response.status !== 200) {
      if (response.status === 401 || response.status === 403) {
        await this.credentials.clearDeviceCredential();
      }
      throw errorFromResponse(response.status, response.body);
    }
    const parsed = parseJson(response.body);
    const rotated = parsed ? parseCredential(parsed, current) : undefined;
    if (!rotated) {
      throw new GatewayClientError("invalid_response", "Credential refresh response is invalid", false);
    }
    await this.credentials.storeDeviceCredential(rotated);
    return rotated;
  }
}
