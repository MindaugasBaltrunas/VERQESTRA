// Task 090-A-02: `claudeDispatchPorts(...).resolveAttempt` privalo IŠSPRĘSTI bandymo
// `claude-last` kelią, o ne grąžinti besąlygišką `reason=no-runtime` stub'ą.
//
// Kodėl tai atskiras testas, o ne eilutė `interfaces-cli-dispatch-command.test.ts`: tenykščiai
// portai yra FAKE, tad jie tikrina tik kanalo pratekėjimą nuo `resolveAttempt` iki
// `launchProcess`. Čia einama per REALŲ kompozicijos adapterį ir realią attempt saugyklą —
// vienintelė vieta, kur matyti, ar dispatch'as apskritai turi kur rašyti sesijos žurnalą.
//
// Kaina, kai kelio nėra: `claude-last` gyvena tik globaliame `vq/logs` veidrodyje, kurį
// perrašo bet kuris lygiagretus worker'is, ir `readClaudeSessionLog` grąžina `legacy` —
// SVETIMO task'o tekstą — vietoj `attempt`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAttempt, openAttempt } from "../infrastructure/persistence/runtime-artifact-store.js";
import { noRuntimeAttemptResolution, type AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";
import { claudeDispatchPorts } from "../composition/agent/dispatch-adapters.js";

const TASK = "0042";
const REF: AttemptRef = { runId: "r090", workerId: "w1", taskId: TASK, attemptId: "a1" };

async function workspace(): Promise<{ projectRoot: string; runtimeRoot: string; agRoot: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-090-attempt-channel-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  return { projectRoot, runtimeRoot, agRoot: path.join(projectRoot, "AG") };
}

/** Rezoliucija per REALIĄ saugyklą: svetimas task id — `no-runtime`, kaip pilname resolveryje. */
function attemptOnlyResolution(runtimeRoot: string, ref: AttemptRef): AttemptResolutionPort {
  return {
    async resolveActiveAttempt(taskId) {
      if (taskId !== ref.taskId) return { ok: false, reason: "no-runtime", errors: [] };
      const handle = await openAttempt(runtimeRoot, ref);
      if (!handle.ok) return { ok: false, reason: "not-created", errors: handle.errors };
      return { ok: true, attempt: { handle: handle.data, manifest: handle.data.manifest } };
    },
  };
}

test("resolveAttempt: išspręstas attempt'as duoda attempt kanalo claude-last kelią be įspėjimų", async () => {
  const world = await workspace();
  try {
    const created = await createAttempt({
      runtimeRoot: world.runtimeRoot,
      ref: REF,
      graphHash: "none",
      policy: {},
      source: { origin: "queue-task" },
      createdAt: "2026-08-30T00:00:00.000Z",
    });
    assert.ok(created.ok);

    const ports = claudeDispatchPorts({ ...world, resolution: attemptOnlyResolution(world.runtimeRoot, REF) });
    const resolved = await ports.resolveAttempt({
      taskId: TASK,
      phase: "implementation",
      taskFile: path.join(world.agRoot, "tasks", "queue", `${TASK}-demo.md`),
    });

    // Kelias tikrinamas per UODEGĄ, o ne per `attemptLogPath` perkvietimą: kartojant tą patį
    // builder'į testas sutaptų su kodu ir nebematytų pakeisto kanalo pavadinimo ar katalogo.
    assert.ok(resolved.claudeLogPath !== undefined);
    assert.ok(
      resolved.claudeLogPath?.endsWith(path.join("attempts", REF.attemptId, "logs", "claude-last.log")),
      `netikėtas kelias: ${String(resolved.claudeLogPath)}`,
    );
    assert.ok(resolved.claudeLogPath?.startsWith(world.runtimeRoot));
    assert.deepEqual(resolved.warnings, []);
    // Pilnas `DispatchAttemptView` šiame task'e NEĮVIELINTAS — kiti kanalai lieka veidrodžiuose.
    assert.equal(resolved.attempt, undefined);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("resolveAttempt: nepavykusi rezoliucija — be kelio, su įvardyta priežastimi (fail-open)", async () => {
  const world = await workspace();
  try {
    const ports = claudeDispatchPorts({ ...world, resolution: noRuntimeAttemptResolution });
    const resolved = await ports.resolveAttempt({
      taskId: TASK,
      phase: "implementation",
      taskFile: path.join(world.agRoot, "tasks", "queue", `${TASK}-demo.md`),
    });

    assert.equal(resolved.claudeLogPath, undefined);
    assert.equal(resolved.attempt, undefined);
    assert.equal(resolved.warnings.length, 1);
    // Priežastis yra visa įspėjimo vertė: be jos „nėra attempt'o" neatskiria normalios repo
    // būsenos nuo tapatybės konflikto.
    assert.match(resolved.warnings[0] ?? "", /runtime attempt namespace unavailable/);
    assert.match(resolved.warnings[0] ?? "", /reason=no-runtime/);
    assert.match(resolved.warnings[0] ?? "", /artifacts fall back to global mirrors/);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
