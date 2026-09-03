import { describe, expect, it, vi } from "vitest";
import {
  runRestartLoop,
  RESTART_CANCELLED_MESSAGE_KEY,
  type RestartLoopDeps,
  type RestartPhase,
} from "../../model/restartLoop";
import type { LoopRunState } from "../../model/loopControlsViewModel";

/**
 * Laikas įleidžiamas iš išorės, tad testas tikrina VISAS šakas be nė vienos realios sekundės:
 * `wait` yra `vi.fn`, o ne fake timers — laukimo KIEKIS irgi yra tikrinamas faktas (riba baigtinė).
 */
function deps(overrides: Partial<RestartLoopDeps> = {}) {
  const phases: RestartPhase[] = [];
  const base = {
    stopLoop: vi.fn().mockResolvedValue({ status: "stop-requested", pid: 42 }),
    readLoopStatus: vi.fn<() => Promise<LoopRunState>>().mockResolvedValue("stopped"),
    startLoop: vi.fn().mockResolvedValue({ status: "started", pid: 77 }),
    wait: vi.fn(() => Promise.resolve()),
    onPhase: (phase: RestartPhase) => phases.push(phase),
    ...overrides,
  } satisfies RestartLoopDeps;
  return { ...base, phases };
}

describe("runRestartLoop", () => {
  it("stops, confirms the stop, and only then starts again", async () => {
    const d = deps({
      readLoopStatus: vi.fn<() => Promise<LoopRunState>>()
        .mockResolvedValueOnce("running")
        .mockResolvedValueOnce("stopped"),
    });

    const outcome = await runRestartLoop(d, { workers: 2, pollAttempts: 5, pollIntervalMs: 10 });

    expect(outcome).toEqual({ ok: true, polls: 2, startedPid: 77, alreadyRunning: false });
    expect(d.startLoop).toHaveBeenCalledWith(2);
    expect(d.phases).toEqual(["stopping", "waiting", "starting", "done"]);
  });

  it("never starts a loop that has not been confirmed as stopped", async () => {
    const d = deps({ readLoopStatus: vi.fn<() => Promise<LoopRunState>>().mockResolvedValue("running") });

    const outcome = await runRestartLoop(d, { workers: 1, pollAttempts: 3, pollIntervalMs: 10 });

    expect(outcome).toEqual({
      ok: false,
      phase: "waiting",
      messageKey: "Restart cancelled: the loop is still running after the stop request, so it was not restarted.",
    });
    // Būtent tai yra visa perkrovimo esmė: nepatvirtintas sustojimas NEGALI baigtis paleidimu.
    expect(d.startLoop).not.toHaveBeenCalled();
    // Riba baigtinė: lygiai tiek laukimų, kiek leista bandymų.
    expect(d.wait).toHaveBeenCalledTimes(3);
    expect(d.phases.at(-1)).toBe("error");
  });

  it("treats an unconfirmable state as a reason to stop, not as permission to start", async () => {
    const d = deps({ readLoopStatus: vi.fn<() => Promise<LoopRunState>>().mockResolvedValue("unknown") });

    const outcome = await runRestartLoop(d, { workers: 1, pollAttempts: 2, pollIntervalMs: 10 });

    expect(outcome).toMatchObject({
      ok: false,
      phase: "waiting",
      messageKey: "Restart cancelled: the loop state could not be confirmed, so it was not restarted.",
    });
    expect(d.startLoop).not.toHaveBeenCalled();
  });

  it("carries the read error to the screen when no poll could answer", async () => {
    const d = deps({
      readLoopStatus: vi.fn<() => Promise<LoopRunState>>().mockRejectedValue(new Error("HTTP 503: ui server restarting")),
    });

    const outcome = await runRestartLoop(d, { workers: 1, pollAttempts: 2, pollIntervalMs: 10 });

    expect(outcome).toEqual({
      ok: false,
      phase: "waiting",
      messageKey: "Restart cancelled: the loop state could not be confirmed, so it was not restarted.",
      detail: "HTTP 503: ui server restarting",
    });
    expect(d.startLoop).not.toHaveBeenCalled();
  });

  it("does not wait or start when the stop request itself was refused", async () => {
    const d = deps({ stopLoop: vi.fn().mockRejectedValue(new Error("HTTP 500: stop flag not writable")) });

    const outcome = await runRestartLoop(d, { workers: 1, pollAttempts: 3, pollIntervalMs: 10 });

    expect(outcome).toEqual({
      ok: false,
      phase: "stopping",
      messageKey: "Restart failed: the loop did not accept the stop request.",
      detail: "HTTP 500: stop flag not writable",
    });
    expect(d.wait).not.toHaveBeenCalled();
    expect(d.startLoop).not.toHaveBeenCalled();
  });

  it("reports a failed stop status with the server reason", async () => {
    const d = deps({ stopLoop: vi.fn().mockResolvedValue({ status: "failed", reason: "pid file locked" }) });

    const outcome = await runRestartLoop(d, { workers: 1, pollIntervalMs: 10 });

    expect(outcome).toEqual({
      ok: false,
      phase: "stopping",
      messageKey: "Restart failed: the loop did not accept the stop request.",
      detail: "pid file locked",
    });
    expect(d.startLoop).not.toHaveBeenCalled();
  });

  it("still verifies the stop when this UI knows no loop process", async () => {
    // „Šis UI nežino gyvo proceso" NĖRA įrodymas, kad ciklas sustojo — jis gali suktis terminale.
    const d = deps({ stopLoop: vi.fn().mockResolvedValue({ status: "stop-requested-no-known-process" }) });

    const outcome = await runRestartLoop(d, { workers: 1, pollAttempts: 4, pollIntervalMs: 10 });

    expect(outcome).toMatchObject({ ok: true, polls: 1 });
    expect(d.wait).toHaveBeenCalledTimes(1);
    expect(d.readLoopStatus).toHaveBeenCalledTimes(1);
  });

  it("names the start failure instead of leaving the loop silently stopped", async () => {
    const d = deps({ startLoop: vi.fn().mockResolvedValue({ status: "failed", reason: "spawn EINVAL" }) });

    const outcome = await runRestartLoop(d, { workers: 1, pollIntervalMs: 10 });

    expect(outcome).toEqual({
      ok: false,
      phase: "starting",
      messageKey: "Restart failed: the loop stopped but did not start again.",
      detail: "spawn EINVAL",
    });
    expect(d.phases.at(-1)).toBe("error");
  });

  it("reports a loop someone else started as a success with its own sentence", async () => {
    const d = deps({ startLoop: vi.fn().mockResolvedValue({ status: "already-running", pid: 9 }) });

    const outcome = await runRestartLoop(d, { workers: 1, pollIntervalMs: 10 });

    expect(outcome).toEqual({ ok: true, polls: 1, alreadyRunning: true });
    expect(d.phases).toEqual(["stopping", "waiting", "starting", "done"]);
  });

  it("waits before the first read, because a stop takes effect between tasks", async () => {
    const order: string[] = [];
    const d = deps({
      wait: vi.fn(() => {
        order.push("wait");
        return Promise.resolve();
      }),
      readLoopStatus: vi.fn(() => {
        order.push("read");
        return Promise.resolve<LoopRunState>("stopped");
      }),
    });

    await runRestartLoop(d, { workers: 1, pollIntervalMs: 10 });

    expect(order).toEqual(["wait", "read"]);
  });
});

/**
 * Atšaukimas = rodinys uždarytas (operatorius perėjo į `#/analytics` ir pan.). Blogiausias atvejis,
 * kurį šie testai užrakina: uždarytas ekranas PALEIDŽIA ciklą ir apie tai niekas nebepraneša.
 */
describe("runRestartLoop cancellation", () => {
  it("stops during the wait and never starts the loop", async () => {
    const abort = new AbortController();
    const d = deps({
      signal: abort.signal,
      // Rodinys išmontuojamas kaip tik laukiant — tai vienintelis ilgas šios eigos tarpas.
      wait: vi.fn((_ms: number, _signal?: AbortSignal) => {
        abort.abort();
        return Promise.resolve();
      }),
    });

    const outcome = await runRestartLoop(d, { workers: 2, pollAttempts: 5, pollIntervalMs: 10 });

    expect(outcome).toEqual({
      ok: false,
      phase: "waiting",
      messageKey: RESTART_CANCELLED_MESSAGE_KEY,
      cancelled: true,
    });
    expect(d.startLoop).not.toHaveBeenCalled();
    // Po atšaukimo būsena nebeskaitoma: laukimas nutrūko, o ne pratęsė ciklą kitu bandymu.
    expect(d.readLoopStatus).not.toHaveBeenCalled();
    expect(d.wait).toHaveBeenCalledTimes(1);
    // Atšaukimas nėra gedimas, tad ir `error` fazės nėra.
    expect(d.phases).toEqual(["stopping", "waiting"]);
  });

  it("stops after the confirmed stop and still never starts the loop", async () => {
    const abort = new AbortController();
    const d = deps({
      signal: abort.signal,
      readLoopStatus: vi.fn(() => {
        // Sustojimas PATVIRTINTAS, bet rodinio nebėra: patvirtinimas nėra leidimas paleisti.
        abort.abort();
        return Promise.resolve<LoopRunState>("stopped");
      }),
    });

    const outcome = await runRestartLoop(d, { workers: 1, pollAttempts: 3, pollIntervalMs: 10 });

    expect(outcome).toMatchObject({ ok: false, cancelled: true, messageKey: RESTART_CANCELLED_MESSAGE_KEY });
    expect(d.startLoop).not.toHaveBeenCalled();
  });

  it("passes the signal to the wait, so a cancelled restart holds no timer", async () => {
    const abort = new AbortController();
    const d = deps({ signal: abort.signal });

    await runRestartLoop(d, { workers: 1, pollAttempts: 2, pollIntervalMs: 10 });

    expect(d.wait).toHaveBeenCalledWith(10, abort.signal);
  });
});
