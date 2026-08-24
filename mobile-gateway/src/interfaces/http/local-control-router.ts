import { randomUUID } from "node:crypto";
import { DeviceAuthError } from "../../application/device-auth-service.js";
import {
  LocalProofVerifier,
  verifyIntegrationConfirmation,
} from "../../application/local-control-auth.js";
import { LocalControlError } from "../../application/local-control-errors.js";
import type { LocalControlService } from "../../application/local-control-service.js";
import {
  assertDigest,
  CommandIntentError,
  INTEGRATION_STRATEGIES,
  type IntegrationConfirmation,
  type IntegrationStrategy,
  type LocalIntegrationService,
} from "../../application/local-integration-service.js";
import {
  assertLocalPeerTrusted,
  assertLoopbackHost,
  type LocalPeerPolicy,
} from "../../application/local-peer-policy.js";
import type { AuditEvent, AuditPort } from "../../application/ports/audit-port.js";
import type {
  LocalControlRequest,
  LocalControlResponse,
} from "../../application/ports/local-control-listener-port.js";
import type { LocalControlSecretPort } from "../../application/ports/local-control-secret-port.js";
import type { SessionGateService } from "../../application/session-gate-service.js";
import { TerminalSupervisorError } from "../../application/terminal-supervisor.js";
import {
  commitField,
  errorResponse,
  exactKeys,
  integerField,
  jsonObject,
  LOCAL_OWNER,
  MAX_CONFIRMATION_LENGTH,
  MAX_LOCAL_BODY_BYTES,
  okResponse,
  PROOF_HEADER_NAME,
  stringField,
  targetOf,
  uuidField,
  UUID_PATTERN,
  type LocalAuditDraft,
} from "./local-control-contract.js";

/**
 * HTTP surface of the local host contract.
 *
 * It is a SEPARATE router from `RemoteGatewayRouter` by design, not by
 * convenience: `local-control-contract.md` excludes these paths from the remote
 * OpenAPI document, and the only way that exclusion can be verified rather than
 * promised is for the phone-facing router to have no branch that could ever
 * reach them. Nothing here is registered there, and nothing here appears in
 * `GATEWAY_ROUTE_SURFACE`.
 *
 * Every request is decided in the same order, and the order is the point:
 *
 * 1. the request target is READ — never acted on — so the audit record knows
 *    which operation was attempted even if the caller is refused at the door;
 * 2. body size — a bound that must hold before anything hashes or parses it;
 * 3. peer trust — is the caller the local owner at all;
 * 4. `Host` — on the loopback fallback, is the request even addressed here;
 * 5. local proof — does the caller hold the host secret for THIS method, path
 *    and body;
 * 6. route parameters and body — an unknown target is a 404 that never reads a
 *    body;
 * 7. the service;
 * 8. the audit record, which fails the request closed if it cannot be written.
 *
 * Step 1 changes nothing a caller can observe: no service is reached, no body is
 * parsed and the response to a failed admission is identical for a known and an
 * unknown path. What it changes is what the HOST can observe — a rejected peer
 * or a forged proof against a real local operation now leaves a `denied` record
 * instead of no record at all, which is the difference between a detectable
 * attempt and a silent one.
 *
 * Formos, validatoriai ir maršruto atpažinimas gyvena `local-control-contract.ts`.
 * `MAX_LOCAL_BODY_BYTES` re-eksportuojamas iš čia, nes transportas
 * (`node-local-control-listener`) importuoja jį šiuo keliu — etalone jis buvo šio failo
 * eksportas, ir dvi to bound'o kopijos, kurios išsiskirtų, leistų transportui priimti kūną,
 * kurį routeris paskui atmeta.
 */

export {
  LOCAL_CONTROL_ROUTE_SURFACE,
  MAX_LOCAL_BODY_BYTES,
  RECOVERABLE_BY_CODE,
  STATUS_BY_CODE,
} from "./local-control-contract.js";

export type LocalControlRouterDependencies = Readonly<{
  control: LocalControlService;
  integrations: LocalIntegrationService;
  /**
   * Required, not optional. An optional gate service would turn a
   * misconfigured host into a 404 for a route the contract declares, and an
   * operator reads a 404 as "this version has no gates", not as "this host is
   * not set up". `SessionGateService` validates its catalogue in its own
   * constructor, so a host that cannot run the gates fails at composition time.
   */
  gates: SessionGateService;
  secrets: LocalControlSecretPort;
  proofs?: LocalProofVerifier;
  peerPolicy: LocalPeerPolicy;
  /**
   * Required, exactly as on the remote router: these are the most consequential
   * actions the gateway performs, and an omitted sink would silently drop their
   * only durable record.
   */
  audit: AuditPort;
  /** Port the loopback fallback is bound to; absent means no loopback listener. */
  loopbackPort?: number;
  now?: () => Date;
}>;

/** An audit record could not be written for an action that requires one. */
class AuditWriteError extends Error {}

export class LocalControlRouter {
  private readonly control: LocalControlService;
  private readonly integrations: LocalIntegrationService;
  private readonly gates: SessionGateService;
  private readonly secrets: LocalControlSecretPort;
  private readonly proofs: LocalProofVerifier;
  private readonly peerPolicy: LocalPeerPolicy;
  private readonly audit: AuditPort;
  private readonly loopbackPort: number | undefined;
  private readonly now: () => Date;

  constructor(dependencies: LocalControlRouterDependencies) {
    this.control = dependencies.control;
    this.integrations = dependencies.integrations;
    this.gates = dependencies.gates;
    this.secrets = dependencies.secrets;
    this.proofs = dependencies.proofs ?? new LocalProofVerifier();
    this.peerPolicy = dependencies.peerPolicy;
    this.audit = dependencies.audit;
    this.loopbackPort = dependencies.loopbackPort;
    this.now = dependencies.now ?? (() => new Date());
  }

  async handle(request: LocalControlRequest): Promise<LocalControlResponse> {
    const correlationId = randomUUID();
    const draft: LocalAuditDraft = {};
    let response: LocalControlResponse;
    try {
      response = await this.route(request, draft, correlationId);
    } catch (error) {
      response = this.errorFor(error, correlationId);
    }
    try {
      await this.recordAudit(draft, response, correlationId);
    } catch (error) {
      if (error instanceof AuditWriteError) {
        // An unaudited local mutation is a repudiation failure. The caller's
        // request id makes the retry safe, so failing closed costs nothing that
        // matters and preserves the record.
        return errorResponse("internal_error", "Internal gateway error", correlationId);
      }
      throw error;
    }
    return response;
  }

  private errorFor(error: unknown, correlationId: string): LocalControlResponse {
    if (error instanceof LocalControlError) {
      return errorResponse(error.code, error.message, correlationId);
    }
    if (error instanceof CommandIntentError) {
      // The domain vocabulary is a subset of the local one; no re-decision.
      return errorResponse(error.code, error.message, correlationId);
    }
    if (error instanceof TerminalSupervisorError) {
      if (error.code === "session_not_live") {
        return errorResponse("session_not_live", "Terminal session is not live", correlationId);
      }
      if (error.code === "session_revision_mismatch") {
        return errorResponse("conflict", "Terminal session moved since it was observed", correlationId);
      }
      if (error.code === "process_identity_unverified") {
        return errorResponse("conflict", "Process identity could not be verified", correlationId);
      }
      if (error.code === "duplicate_request") {
        return errorResponse("duplicate_request", "Request id was reused", correlationId);
      }
      return errorResponse("internal_error", "Internal gateway error", correlationId);
    }
    if (error instanceof DeviceAuthError) {
      if (error.code === "insufficient_scope") {
        return errorResponse("forbidden", "Scope does not allow this operation", correlationId);
      }
      return errorResponse("unauthenticated", "Device authentication failed", correlationId);
    }
    // Nothing of an unrecognised failure reaches the caller: an operator reads
    // the correlation id out of the audit record instead.
    return errorResponse("internal_error", "Internal gateway error", correlationId);
  }

  private async recordAudit(
    draft: LocalAuditDraft,
    response: LocalControlResponse,
    correlationId: string,
  ): Promise<void> {
    if (!draft.action) {
      return;
    }
    const errorBody = response.body["error"] as { code?: string } | undefined;
    const event: AuditEvent = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      action: draft.action,
      outcome: response.status < 400 ? "allowed" : response.status < 500 ? "denied" : "failed",
      correlationId,
      ...(draft.deviceId ? { deviceId: draft.deviceId } : {}),
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
      ...(draft.requestId ? { requestId: draft.requestId } : {}),
      ...(response.status >= 400 && errorBody?.code ? { reasonCode: errorBody.code } : {}),
    };
    try {
      await this.audit.record(event);
    } catch {
      throw new AuditWriteError("Audit record could not be written");
    }
  }

  /** Steps 1–4: everything that must hold before a route may be considered. */
  private async admit(request: LocalControlRequest): Promise<void> {
    if (request.body !== undefined && request.body.byteLength > MAX_LOCAL_BODY_BYTES) {
      throw new LocalControlError(
        "invalid_request",
        `Request body exceeds the ${MAX_LOCAL_BODY_BYTES} byte limit`,
      );
    }
    assertLocalPeerTrusted(request.peer, this.peerPolicy);
    if (request.peer.transport === "loopback-http") {
      if (this.loopbackPort === undefined) {
        throw new LocalControlError("forbidden", "No loopback listener is configured");
      }
      assertLoopbackHost(request.headers["host"], this.loopbackPort);
    }
    const secret = await this.secrets.load();
    if (!secret.fileGuarded) {
      throw new LocalControlError("forbidden", "Local control secret file is not owner-only");
    }
    this.proofs.verify({
      secret: secret.secret,
      method: request.method,
      path: request.path,
      body: request.body,
      header: request.headers[PROOF_HEADER_NAME],
      now: this.now(),
    });
  }

  private async route(
    request: LocalControlRequest,
    draft: LocalAuditDraft,
    correlationId: string,
  ): Promise<LocalControlResponse> {
    // Read-only: the draft is filled in before admission so that a refused peer
    // or an invalid proof is recorded against the operation it was aimed at.
    // Nothing here validates or acts on the request.
    const target = targetOf(request);
    if (target) {
      draft.action = target.action;
      if (target.parameter && UUID_PATTERN.test(target.parameter)) {
        if (target.kind === "revoke") {
          draft.deviceId = target.parameter;
        } else {
          draft.sessionId = target.parameter;
        }
      }
    }

    await this.admit(request);

    if (!request.path.startsWith("/") || request.path.startsWith("//")) {
      throw new LocalControlError("invalid_request", "Request target must use origin form");
    }
    if (!target) {
      // Unknown target: refused before any body is read, so an unimplemented
      // path cannot be probed for the shape of its DTO.
      return errorResponse("not_found", "Route not found", correlationId);
    }

    if (target.kind === "pairing-challenges") {
      const value = jsonObject(request);
      exactKeys(value, ["deviceName", "scopes"]);
      const scopes = value["scopes"];
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
        throw new LocalControlError("invalid_request", "Field scopes must be an array of strings");
      }
      const challenge = await this.control.createPairingChallenge({
        deviceName: stringField(value["deviceName"], "deviceName", 80),
        scopes: scopes as readonly string[],
      });
      return okResponse(201, { ...challenge });
    }

    if (target.kind !== "revoke") {
      const sessionId = uuidField(target.parameter, "sessionId");
      draft.sessionId = sessionId;
      if (target.kind === "force-close") {
        const value = jsonObject(request);
        exactKeys(value, ["requestId", "reason", "expectedSessionRevision"]);
        const requestId = uuidField(value["requestId"], "requestId");
        draft.requestId = requestId;
        const closed = await this.control.forceCloseSession({
          requestId,
          sessionId,
          reason: stringField(value["reason"], "reason", 200),
          expectedSessionRevision: integerField(
            value["expectedSessionRevision"],
            "expectedSessionRevision",
            1,
          ),
        });
        return okResponse(200, { ...closed });
      }
      if (target.kind === "gates") {
        // 200, not 201: re-running the gates replaces the session's record
        // rather than creating a new subordinate resource. The body is empty
        // like the preview's — what to measure is decided entirely by the
        // registry — and the gate results are copied out of the frozen readonly
        // array the service returns.
        this.assertEmptyBody(request);
        const run = await this.gates.runGates({ sessionId, actor: LOCAL_OWNER });
        return okResponse(200, { ...run, gates: run.gates.map((gate) => ({ ...gate })) });
      }
      if (target.kind === "integration-preview") {
        this.assertEmptyBody(request);
        const preview = await this.integrations.preview({ sessionId, actor: LOCAL_OWNER });
        return okResponse(200, { ...preview, changedFiles: [...preview.changedFiles] });
      }
      const confirmation = this.confirmationDto(request);
      const secret = await this.secrets.load();
      const result = await this.integrations.integrate({
        sessionId,
        confirmation,
        actor: LOCAL_OWNER,
        // Re-auth is verified inside the service, in the same exclusive section
        // that spends the preview and re-reads Git, so the proof and the state
        // it authorises are decided at one moment rather than two. The preview
        // is spent BEFORE this callback runs: a confirmation that fails the
        // proof has already burned it, which fails closed and costs only a
        // second preview.
        verifyConfirmation: (candidate) => verifyIntegrationConfirmation(
          secret.secret,
          {
            integrationId: candidate.integrationId,
            diffDigest: candidate.diffDigest,
            gateDigest: candidate.gateDigest,
          },
          candidate.confirmation,
        ),
      });
      return okResponse(200, { ...result });
    }

    const deviceId = uuidField(target.parameter, "deviceId");
    draft.deviceId = deviceId;
    const value = jsonObject(request);
    exactKeys(value, ["requestId", "reason"]);
    const requestId = uuidField(value["requestId"], "requestId");
    draft.requestId = requestId;
    const revoked = await this.control.revokeDevice({
      requestId,
      deviceId,
      reason: stringField(value["reason"], "reason", 200),
    });
    return okResponse(200, { ...revoked, revokedSessionIds: [...revoked.revokedSessionIds] });
  }

  /** The preview takes no input; an empty object is accepted, anything else is not. */
  private assertEmptyBody(request: LocalControlRequest): void {
    if (request.body === undefined || request.body.byteLength === 0) {
      return;
    }
    exactKeys(jsonObject(request), []);
  }

  private confirmationDto(request: LocalControlRequest): IntegrationConfirmation {
    const value = jsonObject(request);
    exactKeys(value, [
      "integrationId",
      "sourceCommit",
      "expectedTargetHead",
      "diffDigest",
      "gateDigest",
      "strategy",
      "confirmation",
    ]);
    const diffDigest = stringField(value["diffDigest"], "diffDigest", 128);
    const gateDigest = stringField(value["gateDigest"], "gateDigest", 128);
    assertDigest(diffDigest, "diffDigest");
    assertDigest(gateDigest, "gateDigest");
    const strategy = stringField(value["strategy"], "strategy", 32);
    if (!(INTEGRATION_STRATEGIES as readonly string[]).includes(strategy)) {
      throw new LocalControlError("invalid_request", `Unsupported integration strategy: ${strategy}`);
    }
    return Object.freeze({
      integrationId: uuidField(value["integrationId"], "integrationId"),
      sourceCommit: commitField(value["sourceCommit"], "sourceCommit"),
      expectedTargetHead: commitField(value["expectedTargetHead"], "expectedTargetHead"),
      diffDigest,
      gateDigest,
      strategy: strategy as IntegrationStrategy,
      confirmation: stringField(value["confirmation"], "confirmation", MAX_CONFIRMATION_LENGTH),
    });
  }
}
