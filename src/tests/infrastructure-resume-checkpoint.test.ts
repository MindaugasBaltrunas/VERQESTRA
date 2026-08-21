// VQ-504 (20/N) testai — resume checkpoint'as ant REALIOS failų sistemos.
//
// Pin'inama tai, kas svarbu PO PROCESO KRITIMO: neperskaitomas checkpoint'as grąžina
// `undefined` (o ne dalinius laukus), rašymo klaida nekyla į kvietėją, o žurnalo statistika
// yra nuliai, kai log'o dar nėra.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import {
  readResumeCheckpoint,
  recordResumeCheckpoint,
  resumeCheckpointFile,
} from "../infrastructure/state/resume-checkpoint.js";

async function makeWorld(): Promise<{ root: string; runtimeRoot: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "vq-resume-"));
  const runtimeRoot = path.join(root, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
  return { root, runtimeRoot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("įrašo checkpoint'ą, resume.log eilutę ir grąžina jį atgal", async () => {
  const world = await makeWorld();
  try {
    const logFile = path.join(world.runtimeRoot, "logs", "claude-last.log");
    await writeFile(logFile, "pirma\nantra\n", "utf8");

    await recordResumeCheckpoint({
      projectRoot: world.root,
      runtimeRoot: world.runtimeRoot,
      resolution: noRuntimeAttemptResolution,
      checkpoint: {
        actor: "claude",
        phase: "implementation",
        status: "started",
        task_id: "0042",
        task_file: path.join(world.root, "AG", "tasks", "queue", "0042.md"),
        log_file: logFile,
        next_action: "dispatch",
      },
      now: () => "2026-08-21T00:00:00.000Z",
    });

    const read = await readResumeCheckpoint(world.runtimeRoot, "claude");
    assert.equal(read?.status, "started");
    assert.equal(read?.task_id, "0042");
    assert.equal(read?.log_lines, 2, "tuščios eilutės neskaičiuojamos");
    assert.ok((read?.log_bytes ?? 0) > 0);
    // Keliai saugomi projekto atžvilgiu POSIX forma — kitaip win32 checkpoint'as būtų
    // neperskaitomas kitoje platformoje.
    assert.equal(read?.task_file, "AG/tasks/queue/0042.md");

    const resumeLog = await readFile(path.join(world.runtimeRoot, "logs", "resume.log"), "utf8");
    assert.match(resumeLog, /claude started phase=implementation task=0042/);
  } finally {
    await world.cleanup();
  }
});

test("be log failo statistika yra nuliai, o checkpoint'as vis tiek atsiranda", async () => {
  const world = await makeWorld();
  try {
    await recordResumeCheckpoint({
      projectRoot: world.root,
      runtimeRoot: world.runtimeRoot,
      checkpoint: { actor: "supervisor", phase: "preflight", status: "started", task_id: "0042" },
    });
    const read = await readResumeCheckpoint(world.runtimeRoot, "supervisor");
    assert.equal(read?.log_bytes, 0);
    assert.equal(read?.log_lines, 0);
  } finally {
    await world.cleanup();
  }
});

test("sugadintas checkpoint'as grąžina undefined, o ne dalinius laukus", async () => {
  const world = await makeWorld();
  try {
    await writeFile(resumeCheckpointFile(world.runtimeRoot, "claude"), '{"actor":"claude"', "utf8");
    assert.equal(await readResumeCheckpoint(world.runtimeRoot, "claude"), undefined);

    // Galiojantis JSON, bet svetima forma — irgi `undefined`: „nežinau, kas vyko" turi vesti
    // į naują planą, o ne į išvestį iš pusiau tinkamų laukų.
    await writeFile(resumeCheckpointFile(world.runtimeRoot, "claude"), '{"actor":"kitas"}', "utf8");
    assert.equal(await readResumeCheckpoint(world.runtimeRoot, "claude"), undefined);
  } finally {
    await world.cleanup();
  }
});

test("nesamas checkpoint'as nėra klaida", async () => {
  const world = await makeWorld();
  try {
    assert.equal(await readResumeCheckpoint(world.runtimeRoot, "claude"), undefined);
  } finally {
    await world.cleanup();
  }
});

test("rašymo klaida NEKYLA į kvietėją", async () => {
  const world = await makeWorld();
  try {
    // `state` yra FAILAS, ne katalogas — rašymas ten neįmanomas.
    await rm(path.join(world.runtimeRoot, "state"), { recursive: true, force: true });
    await writeFile(path.join(world.runtimeRoot, "state"), "kliūtis", "utf8");

    await recordResumeCheckpoint({
      projectRoot: world.root,
      runtimeRoot: world.runtimeRoot,
      checkpoint: { actor: "claude", phase: "implementation", status: "failed", task_id: "0042" },
    });
    // Pasiekus šią eilutę kontraktas įrodytas: buhalterija nenugriovė kelio, kurį aprašo.
    assert.ok(true);
  } finally {
    await world.cleanup();
  }
});
