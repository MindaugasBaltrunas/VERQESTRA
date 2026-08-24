import { revokeTerminalLease } from "../domain/terminal-control-lease.js";
import { transitionTerminalSession } from "../domain/terminal-session.js";
import {
  snapshotOf,
  TerminalSupervisorError,
  type TerminalSessionSnapshot,
} from "./terminal-supervisor-model.js";
import type { TerminalSupervisorRuntime } from "./terminal-supervisor-runtime.js";

/**
 * VIETINIS atkūrimas — `local-control-contract.md` operacijos, kurių nė vienas nuotolinis
 * maršrutas nekviečia.
 *
 * Trečia `terminal-supervisor` skaidymo dalis (žr. `terminal-supervisor-model.ts`). Riba nėra
 * mano išrasta: etalono `TerminalSupervisorError` komentaras ją vardija tiesiai — du klaidų
 * kodai (`session_revision_mismatch`, `process_identity_unverified`) kyla TIK iš šių metodų,
 * ir telefonas jų negali gauti niekada. Atskiras failas tą ribą padaro matomą, o ne
 * paaiškinamą.
 *
 * Laisvos funkcijos, ne klasė: šios operacijos neturi savo būsenos — visa, ką jos keičia,
 * gyvena `TerminalSupervisorRuntime`.
 */

/**
 * What the local operator needs before deciding to force-close a session.
 *
 * It is deliberately narrower than {@link TerminalSessionSnapshot} and is not
 * scoped by project: the caller is the host owner, not a device acting inside
 * one project, and `revision` is here because it is the fencing token
 * {@link forceCloseLocally} demands back.
 */
export async function localSessionView(
  core: TerminalSupervisorRuntime,
  sessionId: string,
): Promise<Readonly<{
  sessionId: string;
  projectId: string;
  state: string;
  revision: number;
  branch: string;
  lease: Readonly<{ ownerDeviceId: string; generation: number }>;
}>> {
  return core.exclusively(async () => {
    const runtime = core.sessions.get(sessionId);
    if (!runtime) {
      throw new TerminalSupervisorError("session_not_live", "Terminal session was not found");
    }
    return Object.freeze({
      sessionId: runtime.session.sessionId,
      projectId: runtime.session.projectId,
      state: runtime.session.state,
      revision: runtime.session.revision,
      branch: runtime.session.branch,
      lease: Object.freeze({
        ownerDeviceId: runtime.lease.ownerDeviceId,
        generation: runtime.lease.generation,
      }),
    });
  });
}

/**
 * Local recovery of a session the operator can no longer reach from the phone.
 *
 * Three guards stand between the request and a termination, in this order:
 * the fencing revision the operator saw must still be current, the process the
 * gateway started must still be the process behind that handle, and only then
 * is the lease revoked and the PTY the gateway itself created closed. The
 * middle guard is why a mismatch ends in `orphaned` WITHOUT terminating
 * anything: a recycled pid belongs to somebody else's program, and this
 * gateway has no business ending it.
 *
 * That middle guard is unconditional. `local-control-contract.md` says the
 * supervisor "verifies the session-owned process-tree identity", so an
 * identity that cannot be verified — no host process table configured, no
 * identity recorded at start, or a probe that failed — is a refusal, never a
 * reason to skip the check. Verification that is optional is verification an
 * attacker only has to make unavailable.
 *
 * `requestId` is carried for the caller's own idempotency ledger; the
 * supervisor does not keep one for a recovery action.
 *
 * The worktree record is untouched throughout — a recovered session still owns
 * its work.
 */
export async function forceCloseLocally(
  core: TerminalSupervisorRuntime,
  input: {
    sessionId: string;
    requestId: string;
    reason: string;
    expectedSessionRevision: number;
  },
): Promise<TerminalSessionSnapshot> {
  return core.exclusively(async () => {
    const runtime = core.sessions.get(input.sessionId);
    if (!runtime) {
      throw new TerminalSupervisorError("session_not_live", "Terminal session was not found");
    }
    if (runtime.session.revision !== input.expectedSessionRevision) {
      // Nothing has happened yet, and nothing will: the operator is acting on
      // a view of the session that is no longer current.
      throw new TerminalSupervisorError(
        "session_revision_mismatch",
        "Terminal session moved since the operator observed it",
      );
    }
    // `orphaned` PRIIMAMAS (2026-08-24, operatoriaus radinys: „terminalo orphaned rezervacija").
    //
    // Būtent orphaned seansui šis kelias ir reikalingas. Nepavykęs `close`/`terminate`/`interrupt`
    // palieka seansą `orphaned` ir SĄMONINGAI nenuvalo `activeSessionId` — kol PTY galbūt dar
    // sukasi, naujas seansas blokuojamas. Rezervaciją atlaisvina `handleExit`, bet jis suveikia
    // tik procesui realiai išėjus — o čia neišėjo būtent tai, kas nepavyko. Atmesdamas orphaned,
    // vienintelis operatoriaus atkūrimo kelias palikdavo hostą užrakintą IKI GATEWAY RESTARTO.
    //
    // Sauga nesumažėja: žemiau esantis tapatybės vartas nepakito — perdirbtas pid baigiasi
    // `orphaned` NIEKO nenutraukiant, o be `processes` lentelės force-close išvis neleidžiamas.
    const forceClosableStates = ["live", "interrupting", "orphaned"] as const;
    if (
      !runtime.handle ||
      !forceClosableStates.some((state) => state === runtime.session.state)
    ) {
      throw new TerminalSupervisorError("session_not_live", "Terminal session is not live");
    }
    const handle = runtime.handle;
    if (!core.processes) {
      // A supervisor without a host process table can never satisfy the
      // contract's identity check, so it does not get to force-close at all.
      // Nothing is orphaned here: the session is intact, the composition is
      // what is missing.
      throw new TerminalSupervisorError(
        "process_identity_unverified",
        "This gateway cannot verify the process identity of a session",
      );
    }
    const recorded = runtime.processIdentity;
    // A probe that throws is a probe that proved nothing; it is treated
    // exactly like a mismatch rather than propagated as an internal failure.
    const observed = recorded
      ? await core.processes.identify(handle.pid).catch(() => undefined)
      : undefined;
    if (
      !recorded ||
      !observed ||
      observed.pid !== recorded.pid ||
      observed.startedAt !== recorded.startedAt ||
      observed.executable !== recorded.executable
    ) {
      runtime.session = transitionTerminalSession(runtime.session, "orphaned");
      core.emitSessionState(runtime, "process identity could not be verified");
      runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
      core.emitLease(runtime);
      await core.syncRegistry(runtime);
      throw new TerminalSupervisorError(
        "process_identity_unverified",
        recorded
          ? "Recorded process identity no longer matches the host"
          : "No process identity was recorded for this session",
      );
    }
    runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
    core.emitLease(runtime);
    // JAU orphaned seansas per `closing` NEEINA: domeno lentelė sako `orphaned: [live, ended]`, ir
    // tai sąmoninga — orphaned nėra uždarymo srautas, jis baigiasi tiesiai, kai baigtis
    // patvirtinama (taip pat elgiasi ir `handleExit`). Ta pati eilutė ir yra priežastis, kodėl
    // priverstinis uždarymas orphaned seansui anksčiau lūždavo `orphaned -> closing`.
    const wasOrphaned = runtime.session.state === "orphaned";
    if (!wasOrphaned) {
      runtime.session = transitionTerminalSession(runtime.session, "closing");
      core.emitSessionState(runtime, input.reason);
    }
    try {
      await handle.terminate();
    } catch {
      core.publishEvents(runtime, runtime.output.flush(core.clock()));
      // Jau orphaned seansas orphaned ir lieka: `orphaned -> orphaned` lentelėje nėra, o būsena
      // nuo nepavykusio bandymo nepasikeitė.
      if (!wasOrphaned) {
        runtime.session = transitionTerminalSession(runtime.session, "orphaned");
      }
      core.emitSessionState(runtime, "force close outcome is unknown");
      await core.syncRegistry(runtime);
      throw new TerminalSupervisorError("session_not_live", "Terminal force close outcome is unknown");
    }
    core.publishEvents(runtime, runtime.output.flush(core.clock()));
    runtime.session = transitionTerminalSession(runtime.session, "ended");
    core.emitSessionState(runtime, input.reason);
    if (core.activeSessionId === runtime.session.sessionId) core.activeSessionId = undefined;
    await core.syncRegistry(runtime);
    return snapshotOf(runtime);
  });
}

/**
 * Fences every session a revoked device owned.
 *
 * Revocation is an authorisation event, so it ends the device's ABILITY to
 * drive a session — the generation moves and the lease expires — and stops
 * there. The agent process keeps running and the worktree keeps its work,
 * because losing a phone is not a reason to discard whatever the agent has
 * produced.
 */
export async function revokeDeviceLeases(
  core: TerminalSupervisorRuntime,
  deviceId: string,
): Promise<readonly string[]> {
  return core.exclusively(async () => {
    const fenced: string[] = [];
    for (const runtime of core.sessions.values()) {
      if (runtime.lease.ownerDeviceId !== deviceId) continue;
      runtime.lease = revokeTerminalLease(runtime.lease, core.clock());
      core.emitLease(runtime);
      fenced.push(runtime.session.sessionId);
      await core.syncRegistry(runtime);
    }
    return Object.freeze(fenced);
  });
}
