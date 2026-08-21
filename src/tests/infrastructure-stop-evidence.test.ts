// VQ-504 (7/N) testai — attempt-first stop įrodymas. Pin'inama tai, kas skiria šį skaitytoją nuo
// paprasto JSON.parse: sugadintas ATTEMPT artefaktas NENUSILEIDŽIA prie legacy veidrodžio, o
// trūkstamas failas nėra korupcija.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { noRuntimeAttemptResolution, type AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import { readStopEvidence } from "../infrastructure/state/stop-evidence.js";

async function makeRuntime(): Promise<{ runtimeRoot: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "vq-stop-evidence-"));
  const runtimeRoot = path.join(root, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  return { runtimeRoot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const mirrorName = "claude-stop-status.json";

/** Attempt handle'o pakaitalas: skaitytojui reikia TIK `readJson("stop-state", schema)`. */
function attemptResolution(read: () => Promise<unknown>): AttemptResolutionPort {
  return {
    resolveActiveAttempt: () =>
      Promise.resolve({ ok: true, attempt: { handle: { readJson: () => read() }, manifest: {} } } as never),
  };
}

test("nėra nei attempt, nei veidrodžio — origin `none` ir NE korupcija", async () => {
  const world = await makeRuntime();
  try {
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: noRuntimeAttemptResolution,
      taskId: "0042",
    });
    assert.equal(evidence.origin, "none");
    assert.equal(evidence.corrupted, false, "nesuveikęs Stop hook'as nėra gedimas");
  } finally {
    await world.cleanup();
  }
});

test("legacy veidrodis skaitomas, kai attempt'o nėra", async () => {
  const world = await makeRuntime();
  try {
    await writeFile(
      path.join(world.runtimeRoot, "state", mirrorName),
      JSON.stringify({ status: "done", reason: "ok", task_id: "0042" }),
      "utf8",
    );
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: noRuntimeAttemptResolution,
      taskId: "0042",
    });
    assert.equal(evidence.origin, "legacy");
    assert.equal(evidence.status, "done");
    assert.equal(evidence.taskId, "0042");
    // Visas įrašas išlieka: susiaurinimas atimtų iš operatoriaus F7 diagnostiką.
    assert.equal(evidence.record["reason"], "ok");
  } finally {
    await world.cleanup();
  }
});

test("sugadintas veidrodis pažymimas korumpuotu, o ne tuščiu", async () => {
  const world = await makeRuntime();
  try {
    await writeFile(path.join(world.runtimeRoot, "state", mirrorName), "{not json", "utf8");
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: noRuntimeAttemptResolution,
      taskId: "0042",
    });
    assert.equal(evidence.origin, "legacy");
    assert.equal(evidence.corrupted, true);
  } finally {
    await world.cleanup();
  }
});

test("attempt įrodymas nugali veidrodį", async () => {
  const world = await makeRuntime();
  try {
    await writeFile(
      path.join(world.runtimeRoot, "state", mirrorName),
      JSON.stringify({ status: "blocked", task_id: "kitas" }),
      "utf8",
    );
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: attemptResolution(() =>
        Promise.resolve({
          ok: true,
          origin: "runtime",
          path: "/a/stop-state.json",
          revision: "r1",
          data: {
            date: "2026-08-21T00:00:00.000Z",
            status: "done",
            reason: "",
            task_id: "0042",
            dispatch_nonce: "n1",
            head: "",
            git_status: "",
          },
        }),
      ),
      taskId: "0042",
    });
    assert.equal(evidence.origin, "attempt");
    assert.equal(evidence.status, "done");
  } finally {
    await world.cleanup();
  }
});

test("SUGADINTAS attempt artefaktas NENUSILEIDŽIA prie veidrodžio", async () => {
  const world = await makeRuntime();
  try {
    // Veidrodyje guli tinkamas done — jei fallback'as veiktų, jis būtų grąžintas ir
    // last-writer-wins priklausomybė grįžtų per galines duris.
    await writeFile(
      path.join(world.runtimeRoot, "state", mirrorName),
      JSON.stringify({ status: "done", task_id: "0042" }),
      "utf8",
    );
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: attemptResolution(() => Promise.resolve({ ok: false, reason: "invalid-json", errors: ["x"] })),
      taskId: "0042",
    });
    assert.equal(evidence.origin, "attempt");
    assert.equal(evidence.corrupted, true);
    assert.equal(evidence.status, undefined);
  } finally {
    await world.cleanup();
  }
});

test("trūkstamas attempt artefaktas leidžia veidrodį BE įspėjimo", async () => {
  const world = await makeRuntime();
  try {
    await writeFile(
      path.join(world.runtimeRoot, "state", mirrorName),
      JSON.stringify({ status: "done", task_id: "0042" }),
      "utf8",
    );
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: attemptResolution(() => Promise.resolve({ ok: false, reason: "missing", errors: [] })),
      taskId: "0042",
    });
    assert.equal(evidence.origin, "legacy");
    assert.deepEqual(evidence.warnings, [], "dar nesuveikęs Stop hook'as nėra nukrypimas");
  } finally {
    await world.cleanup();
  }
});

test("tuščias taskId visai neliečia attempt rezoliucijos", async () => {
  const world = await makeRuntime();
  try {
    let resolved = 0;
    const evidence = await readStopEvidence({
      runtimeRoot: world.runtimeRoot,
      resolution: {
        resolveActiveAttempt: () => {
          resolved += 1;
          return Promise.resolve({ ok: false, reason: "no-runtime", errors: [] });
        },
      },
      taskId: "   ",
    });
    assert.equal(resolved, 0, "be task id nėra ko rezoliuoti");
    assert.equal(evidence.origin, "none");
  } finally {
    await world.cleanup();
  }
});
