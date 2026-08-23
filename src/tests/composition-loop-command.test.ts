// VQ-504 (54/N) testai — loop'o surišimas kompozicijoje.
//
// Surišimo testas negali (ir neturi) sukti tikros bangos: jo darbas — patikrinti, kad portai
// SUJUNGTI teisingai ir kad sprendimai, kurie gimsta būtent čia, yra tie patys, kuriuos aprašo
// application pusė. Prikalama: remonto užduotis atpažįstama pagal bucket'ą IR failą, keliai
// sudedami prieš projekto šaknį, o startas kviečia reaper'ius.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildLoopCyclePorts, type LoopCommandDeps } from "../composition/loop/command.js";
import type { EmptyQueuePorts } from "../application/scheduling/loop-empty-queue.js";

async function deps(): Promise<{ deps: LoopCommandDeps; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-504-loop-"));
  const emptyQueue = {
    detectBootstrapEligibility: () => Promise.resolve({ bootstrapEligible: false }),
    runBootstrap: () => Promise.resolve({ status: "skipped", render: "" }),
    resolveModel: () => Promise.resolve("model"),
    synthesizeWave: () => Promise.resolve({ created: 0, already_implemented: 0, external_satisfied: 0 } as never),
    runQualityGates: () => Promise.resolve(0),
    dispatchAuditRepair: () => Promise.resolve(),
    runConverge: () => Promise.resolve({ issues: [] }),
    log: () => Promise.resolve(),
    out: () => {},
    env: {},
  } as unknown as EmptyQueuePorts;

  return {
    root,
    deps: {
      roots: {
        projectRoot: root,
        agRoot: path.join(root, "AG"),
        runtimeRoot: path.join(root, "vq"),
      },
      log: () => Promise.resolve(),
      out: () => {},
      emptyQueue,
      preconditions: { gitStatusPorcelain: () => Promise.resolve([]) } as never,
      taskSelection: { listMarkdownFilePaths: () => Promise.resolve([]) },
      consumeStopRequest: () => Promise.resolve(false),
      resumeTask: () => Promise.resolve(true),
      processAuditRepairTask: () => Promise.resolve(),
      env: {},
    },
  };
}

test("remonto užduotis atpažįstama pagal bucket'ą IR failą", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);

    assert.equal(ports.isAuditRepairTask({ bucket: "error", file: "AG/tasks/error/claude-audit-repair.md" }), true);
    // Tas pats failas kitame bucket'e nėra remonto kelias: `error` yra jo tapatybės dalis.
    assert.equal(ports.isAuditRepairTask({ bucket: "active", file: "AG/tasks/active/claude-audit-repair.md" }), false);
    assert.equal(ports.isAuditRepairTask({ bucket: "error", file: "AG/tasks/error/0042.md" }), false);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("keliai sudedami prieš projekto šaknį", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);
    assert.equal(ports.absolutePath("AG/tasks/queue/0001.md"), path.join(world.root, "AG/tasks/queue/0001.md"));
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("higienos žingsniai NIEKADA nemeta, net tuščiame kataloge", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);
    // Nei lease store, nei git medžio čia nėra — abu turi grąžinti eilutes, o ne kristi.
    assert.ok(Array.isArray(await ports.reapDeadLeases()));
    assert.ok(Array.isArray(await ports.reapOrphanWorktrees()));
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("tuščia eilė be task'ų duoda `empty`, o ne kritimą", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);
    const selection = await ports.scheduler.nextTask();
    assert.equal(selection.kind, "empty");
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
