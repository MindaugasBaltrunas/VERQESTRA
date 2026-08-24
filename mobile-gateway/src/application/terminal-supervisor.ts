import { randomUUID } from "node:crypto";
import { createTerminalControlLease, renewTerminalControlLease, revokeTerminalLease, StaleTerminalLeaseError } from "../domain/terminal-control-lease.js";
import { TerminalOutputSanitizer } from "../domain/terminal-output-sanitizer.js";
import { TerminalReplayBuffer, type TerminalReplayResult, type TerminalSequencedEvent } from "../domain/terminal-replay-buffer.js";
import { transitionTerminalSession, type AgentProvider, type TerminalSession } from "../domain/terminal-session.js";
import { TerminalOutputPipeline } from "./terminal-output-pipeline.js";
import {
  snapshotOf,
  TerminalSupervisorError,
  UUID_PATTERN,
  validateDimensions,
  type RuntimeSession,
  type TerminalInputResult,
  type TerminalOutputStream,
  type TerminalSessionSnapshot,
  type TerminalSupervisorDependencies,
} from "./terminal-supervisor-model.js";
import { TerminalSupervisorRuntime } from "./terminal-supervisor-runtime.js";
import {
  forceCloseLocally,
  localSessionView,
  revokeDeviceLeases,
} from "./terminal-supervisor-local.js";

/**
 * Vienas mobile terminalo seansas per hostą: sukūrimas, įvestis, dydis, lease, nutraukimas,
 * uždarymas ir skaitymo/srauto paviršius.
 *
 * Ketvirta ir vieša `terminal-supervisor` skaidymo dalis (911 eil. etalone; žr.
 * `terminal-supervisor-model.ts` dėl pjūvių). Ši klasė yra TAS PATS kontraktas, kurį turėjo
 * etalonas — visi metodai tais pačiais vardais ir su tais pačiais parašais, įskaitant
 * vietinio atkūrimo trejetą, kuris čia deleguojamas. Kvietėjams (`terminal-stream-service`,
 * `local-control-service`) skaidymo nesimato.
 */

// Formos gyveno šiame faile ir etalone, tad importo kelias kvietėjams nepakito.
export {
  TerminalSupervisorError,
  validateDimensions,
} from "./terminal-supervisor-model.js";
export type {
  TerminalInputResult,
  TerminalOutputStream,
  TerminalSessionSnapshot,
  TerminalSupervisorDependencies,
  WorktreeAllocationPort,
} from "./terminal-supervisor-model.js";

export class TerminalSupervisor {
  private readonly core: TerminalSupervisorRuntime;

  constructor(dependencies: TerminalSupervisorDependencies) {
    this.core = new TerminalSupervisorRuntime(dependencies);
  }

  async createSession(input: {
    projectId: string;
    ownerDeviceId: string;
    requestId: string;
    provider: AgentProvider;
    workspaceMode: "isolated-worktree";
    cols: number;
    rows: number;
  }): Promise<TerminalSessionSnapshot> {
    const core = this.core;
    return core.exclusively(async () => {
      if (
        !UUID_PATTERN.test(input.projectId) ||
        !UUID_PATTERN.test(input.ownerDeviceId) ||
        input.requestId.length === 0 ||
        input.requestId.length > 200 ||
        !["claude-code", "codex"].includes(input.provider) ||
        input.workspaceMode !== "isolated-worktree"
      ) {
        throw new Error("Terminal session request is invalid");
      }
      validateDimensions(input.cols, input.rows);
      const idempotencyKey = `${input.ownerDeviceId}:${input.requestId}`;
      const existingSessionId = core.createRequests.get(idempotencyKey);
      if (existingSessionId) {
        return snapshotOf(core.requireRuntime(input.projectId, existingSessionId));
      }
      if (core.activeSessionId) {
        throw new TerminalSupervisorError("host_busy", "Another mobile terminal session is active");
      }
      let project;
      try {
        project = core.projects.require(input.projectId);
      } catch {
        throw new TerminalSupervisorError("project_not_found", "Project was not found");
      }
      const head = await core.git.run(project.projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const baseCommit = head.stdout.trim().split(/\s/)[0] ?? "";
      if (head.exitCode !== 0 || !/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
        throw new TerminalSupervisorError("terminal_start_failed", "Repository HEAD could not be resolved");
      }
      const sessionId = randomUUID();
      core.activeSessionId = sessionId;
      let runtime: RuntimeSession | undefined;
      try {
        const allocation = await core.worktrees.allocate({
          repositoryRoot: project.projectRoot,
          sessionId,
          baseCommit,
        });
        let session: TerminalSession = {
          sessionId,
          projectId: project.projectId,
          provider: input.provider,
          workspaceMode: "isolated-worktree",
          branch: allocation.branch,
          baseCommit,
          state: "creating",
          revision: 1,
        };
        session = transitionTerminalSession(session, "starting");
        const replay = new TerminalReplayBuffer(sessionId);
        runtime = {
          session,
          lease: createTerminalControlLease({
            sessionId,
            projectId: project.projectId,
            provider: input.provider,
            ownerDeviceId: input.ownerDeviceId,
            ttlMs: core.leaseTtlMs,
            now: core.clock(),
          }),
          worktreeRoot: allocation.worktreeRoot,
          replay,
          output: new TerminalOutputPipeline(new TerminalOutputSanitizer(), replay),
          inputs: new Map(),
          eventListeners: new Set(),
          // Tuščias lizdas: tapatybė užrašoma tik po `terminals.start`, kai hostas jau turi ką
          // pasakyti apie pid'ą. Etalone laukas tiesiog nebuvo nurodytas — dabar jis nurodomas
          // tuščias, ir tai yra visas skirtumas.
          processIdentity: undefined,
        };
        core.sessions.set(sessionId, runtime);
        runtime.handle = await core.terminals.start({
          sessionId,
          provider: input.provider,
          cwd: runtime.worktreeRoot,
          cols: input.cols,
          rows: input.rows,
          onOutput: (data) => core.handleOutput(sessionId, data),
          onExit: () => core.handleExit(sessionId),
        });
        runtime.session = transitionTerminalSession(runtime.session, "live");
        // Record what the host reports for this pid, not our own spawn clock, so
        // reconciliation later compares like with like.
        runtime.processIdentity = await core.processes?.identify(runtime.handle.pid);
        core.emitSessionState(runtime);
        core.emitLease(runtime);
        // PIRMAS durable rašymas — vienintelis, kuris yra PRIVALOMAS. Tyliai pralaimėjęs, jis
        // grąžindavo `state=live` be jokio įrašo, o `reconcile()` tokio seanso po restarto net
        // negali pažymėti `orphaned`: ji iteruoja tik EGZISTUOJANČIUS įrašus. Klaida čia krenta į
        // tą patį `catch`, kuris uždaro handle ir atšaukia lease.
        await core.syncRegistry(runtime, { required: true });
        // Idempotencijos raktas registruojamas TIK po sėkmingo durable rašymo (2026-08-24).
        //
        // Iki tol jis buvo įrašomas PRIEŠ jį, tad nepavykus registrui raktas likdavo rodyti į
        // seansą, kurio nėra: pakartotinis TAS PATS `requestId` grįždavo per `createRequests`
        // šaką ir gaudavo arba `requireRuntime` klaidą, arba `failed` seanso snapshot'ą — t. y.
        // klientas nebegalėdavo pakartoti prašymo, kuris niekada nepavyko. Po šios eilutės nieko,
        // kas galėtų mesti, nebėra, tad raktas ir įrašas atsiranda kartu arba nė vienas.
        core.createRequests.set(idempotencyKey, sessionId);
        return snapshotOf(runtime);
      } catch (error) {
        if (runtime !== undefined) {
          // `terminals.start` galėjo PAVYKTI, o kristi tai, kas eina po jo (`processes.identify`).
          // Tada PTY jau gyvas, o `catch` iki 2026-08-24 nuimdavo tik `activeSessionId`: procesas
          // likdavo be jokio valdytojo, lease galiojantis, o kitas kvietimas paleisdavo ANTRĄ
          // seansą — atkurta kaip `starts=2, closes=0`, nors hostui deklaruotas vienas.
          //
          // Uždarymas eina PIRMAS ir tyliai: jo nesėkmė negali užgožti tikrosios starto klaidos,
          // o handle, kurio uždaryti nepavyko, vis tiek nebeturi kam priklausyti.
          if (runtime.handle !== undefined) {
            await runtime.handle.close().catch(() => undefined);
          }
          if (runtime.session.state === "starting") {
            runtime.session = transitionTerminalSession(runtime.session, "failed");
            core.emitSessionState(runtime, "terminal start failed");
          }
          // Lease atšaukiamas TUO PAČIU `revokeTerminalLease`, kaip ir įprastame uždaryme: nesėkmingas
          // startas negali palikti galiojančios nuosavybės seansui, kurio nebėra.
          runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
          core.emitLease(runtime);
          await core.syncRegistry(runtime).catch(() => undefined);
        }
        core.activeSessionId = undefined;
        if (error instanceof TerminalSupervisorError) throw error;
        throw new TerminalSupervisorError("terminal_start_failed", "Mobile terminal failed to start");
      }
    });
  }

  async writeInput(input: {
    projectId: string;
    sessionId: string;
    ownerDeviceId: string;
    leaseId: string;
    leaseGeneration: number;
    inputId: string;
    source: "keyboard" | "voice";
    text: string;
  }): Promise<TerminalInputResult> {
    const core = this.core;
    return core.exclusively(async () => {
      const runtime = core.requireRuntime(input.projectId, input.sessionId);
      core.assertFence(runtime, input);
      const existing = runtime.inputs.get(input.inputId);
      if (existing) {
        if (existing.text !== input.text || existing.source !== input.source) {
          throw new TerminalSupervisorError("duplicate_request", "Input id was reused with different content");
        }
        return existing.result;
      }
      if (
        runtime.session.state !== "live" ||
        !runtime.handle ||
        !UUID_PATTERN.test(input.inputId) ||
        !["keyboard", "voice"].includes(input.source) ||
        input.text.length === 0 ||
        input.text.length > 16_384
      ) {
        if (UUID_PATTERN.test(input.inputId)) {
          core.emit(runtime, { type: "server.input", inputId: input.inputId, status: "rejected" });
        }
        throw new TerminalSupervisorError("session_not_live", "Terminal input was rejected");
      }
      const accepted: TerminalInputResult = Object.freeze({ inputId: input.inputId, status: "accepted" });
      runtime.inputs.set(input.inputId, { text: input.text, source: input.source, result: accepted });
      core.emit(runtime, { type: "server.input", inputId: input.inputId, status: "accepted" });
      try {
        await runtime.handle.write(input.text);
        const written: TerminalInputResult = Object.freeze({ inputId: input.inputId, status: "written" });
        runtime.inputs.set(input.inputId, { text: input.text, source: input.source, result: written });
        core.emit(runtime, { type: "server.input", inputId: input.inputId, status: "written" });
        return written;
      } catch {
        const unknown: TerminalInputResult = Object.freeze({ inputId: input.inputId, status: "unknown" });
        runtime.inputs.set(input.inputId, { text: input.text, source: input.source, result: unknown });
        core.emit(runtime, { type: "server.input", inputId: input.inputId, status: "unknown" });
        return unknown;
      }
    });
  }

  async resize(input: {
    projectId: string;
    sessionId: string;
    ownerDeviceId: string;
    leaseId: string;
    leaseGeneration: number;
    cols: number;
    rows: number;
  }): Promise<void> {
    const core = this.core;
    await core.exclusively(async () => {
      validateDimensions(input.cols, input.rows);
      const runtime = core.requireRuntime(input.projectId, input.sessionId);
      core.assertFence(runtime, input);
      if (runtime.session.state !== "live" || !runtime.handle) {
        throw new TerminalSupervisorError("session_not_live", "Terminal session is not live");
      }
      await runtime.handle.resize(input.cols, input.rows);
    });
  }

  /**
   * Extends the control lease of a live session before it expires.
   *
   * The order is the order every other mutation uses — session, fence, liveness
   * — and the liveness check is not an exception to it: extending write access
   * to a terminal that no longer exists would be the one mutation that succeeded
   * against a dead PTY.
   *
   * Nothing about the identity of the lease changes; only `expiresAt` moves. The
   * new expiry is published as a `server.lease` event, which the stream contract
   * already declares, so a phone reading the stream learns the new deadline
   * without a new protocol message, and it is written through to the registry so
   * that reconciliation after a gateway restart does not see a lease that only
   * looked expired on paper.
   */
  async renewLease(input: {
    projectId: string;
    sessionId: string;
    ownerDeviceId: string;
    leaseId: string;
    leaseGeneration: number;
  }): Promise<TerminalSessionSnapshot> {
    const core = this.core;
    return core.exclusively(async () => {
      const runtime = core.requireRuntime(input.projectId, input.sessionId);
      core.assertFence(runtime, input);
      if (runtime.session.state !== "live" || !runtime.handle) {
        throw new TerminalSupervisorError("session_not_live", "Terminal session is not live");
      }
      try {
        runtime.lease = renewTerminalControlLease(
          runtime.lease,
          {
            leaseId: input.leaseId,
            generation: input.leaseGeneration,
            ownerDeviceId: input.ownerDeviceId,
            sessionId: runtime.session.sessionId,
            now: core.clock(),
          },
          core.leaseTtlMs,
        );
      } catch (error) {
        // Unreachable in practice — `assertFence` above has already made the
        // same comparison — but the translation must exist all the same: a
        // domain error may never escape into the interface layer.
        if (error instanceof StaleTerminalLeaseError) {
          throw new TerminalSupervisorError("stale_terminal_lease", "Terminal lease is stale");
        }
        throw error;
      }
      core.emitLease(runtime);
      await core.syncRegistry(runtime);
      return snapshotOf(runtime);
    });
  }

  async interrupt(input: {
    projectId: string;
    sessionId: string;
    ownerDeviceId: string;
    leaseId: string;
    leaseGeneration: number;
  }): Promise<void> {
    const core = this.core;
    await core.exclusively(async () => {
      const runtime = core.requireRuntime(input.projectId, input.sessionId);
      core.assertFence(runtime, input);
      if (runtime.session.state !== "live" || !runtime.handle) {
        throw new TerminalSupervisorError("session_not_live", "Terminal session is not live");
      }
      runtime.session = transitionTerminalSession(runtime.session, "interrupting");
      core.emitSessionState(runtime);
      try {
        await runtime.handle.interrupt();
        runtime.session = transitionTerminalSession(runtime.session, "live");
        core.emitSessionState(runtime);
      } catch {
        runtime.session = transitionTerminalSession(runtime.session, "orphaned");
        core.emitSessionState(runtime, "interrupt outcome is unknown");
        runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
        core.emitLease(runtime);
        await core.syncRegistry(runtime);
        throw new TerminalSupervisorError("session_not_live", "Terminal interrupt failed");
      }
      await core.syncRegistry(runtime);
    });
  }

  /**
   * `close` ir `terminate` skiriasi vienu dalyku — kurį handle metodą kviečia — ir viskuo
   * kitu sutampa. Etalone tai buvo dvi beveik identiškos 36 eilučių kopijos; čia bendra seka
   * gyvena vienoje privačioje vietoje, o skirtumas paduodamas parametru. Elgesys, įskaitant
   * pranešimų tekstus, nepakito nė vienoje šakoje.
   */
  private async endSession(
    input: {
      projectId: string;
      sessionId: string;
      ownerDeviceId: string;
      leaseId: string;
      leaseGeneration: number;
    },
    kind: "close" | "terminate",
  ): Promise<TerminalSessionSnapshot> {
    const core = this.core;
    return core.exclusively(async () => {
      const runtime = core.requireRuntime(input.projectId, input.sessionId);
      core.assertFence(runtime, input);
      if (runtime.session.state !== "live" || !runtime.handle) {
        throw new TerminalSupervisorError("session_not_live", "Terminal session is not live");
      }
      const handle = runtime.handle;
      runtime.session = transitionTerminalSession(runtime.session, "closing");
      core.emitSessionState(runtime);
      try {
        await (kind === "close" ? handle.close() : handle.terminate());
        core.publishEvents(runtime, runtime.output.flush(core.clock()));
        runtime.session = transitionTerminalSession(runtime.session, "ended");
        core.emitSessionState(runtime);
        runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
        core.emitLease(runtime);
        if (core.activeSessionId === runtime.session.sessionId) core.activeSessionId = undefined;
      } catch {
        core.publishEvents(runtime, runtime.output.flush(core.clock()));
        runtime.session = transitionTerminalSession(runtime.session, "orphaned");
        core.emitSessionState(runtime, `${kind} outcome is unknown`);
        runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
        core.emitLease(runtime);
        await core.syncRegistry(runtime);
        throw new TerminalSupervisorError(
          "session_not_live",
          `Terminal ${kind} outcome is unknown`,
        );
      }
      await core.syncRegistry(runtime);
      return snapshotOf(runtime);
    });
  }

  async close(input: {
    projectId: string;
    sessionId: string;
    ownerDeviceId: string;
    leaseId: string;
    leaseGeneration: number;
  }): Promise<TerminalSessionSnapshot> {
    return this.endSession(input, "close");
  }

  async terminate(input: {
    projectId: string;
    sessionId: string;
    ownerDeviceId: string;
    leaseId: string;
    leaseGeneration: number;
  }): Promise<TerminalSessionSnapshot> {
    return this.endSession(input, "terminate");
  }

  /** Vietinio atkūrimo trejetas — realizacija `terminal-supervisor-local.ts`. */
  async localSessionView(sessionId: string): ReturnType<typeof localSessionView> {
    return localSessionView(this.core, sessionId);
  }

  async forceCloseLocally(input: {
    sessionId: string;
    requestId: string;
    reason: string;
    expectedSessionRevision: number;
  }): Promise<TerminalSessionSnapshot> {
    return forceCloseLocally(this.core, input);
  }

  async revokeDeviceLeases(deviceId: string): Promise<readonly string[]> {
    return revokeDeviceLeases(this.core, deviceId);
  }

  async getSession(projectId: string, sessionId: string): Promise<TerminalSessionSnapshot> {
    const core = this.core;
    return core.exclusively(async () => snapshotOf(core.requireRuntime(projectId, sessionId)));
  }

  async replayAfter(
    projectId: string,
    sessionId: string,
    lastAckSequence: number,
  ): Promise<TerminalReplayResult> {
    const core = this.core;
    return core.exclusively(async () => (
      core.requireRuntime(projectId, sessionId).replay.replayAfter(lastAckSequence, core.clock())
    ));
  }

  async openOutputStream(input: {
    projectId: string;
    sessionId: string;
    lastAckSequence: number;
    onEvent: (event: TerminalSequencedEvent) => void;
  }): Promise<TerminalOutputStream> {
    const core = this.core;
    return core.exclusively(async () => {
      const runtime = core.requireRuntime(input.projectId, input.sessionId);
      const replay = runtime.replay.replayAfter(input.lastAckSequence, core.clock());
      runtime.eventListeners.add(input.onEvent);
      let closed = false;
      return Object.freeze({
        snapshot: snapshotOf(runtime),
        replay,
        close: async () => {
          if (closed) return;
          closed = true;
          await core.exclusively(async () => {
            runtime.eventListeners.delete(input.onEvent);
          });
        },
      });
    });
  }
}
