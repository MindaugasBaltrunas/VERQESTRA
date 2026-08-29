// Task 080-a-02 — vaiko exit uodega papildomai į vq/logs/slots/<worker>-<task>-a<attempt>.log.
//
// `command.ts` `runChild` log'ina diagnostiką į `deps.log` (orchestrator.log, rotuojamas) IR
// papildomai append'ina TĄ PAČIĄ eilutę į per-slot failą, kurio gyvavimas nuo rotacijos
// nepriklauso. `appendChildExitSlotLog` yra šio antro rašymo eksportuota dalis — testuojama su
// atmintine fs sąsaja, be realaus vaiko proceso.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { appendChildExitSlotLog } from "../composition/loop/command.js";
import { childExitSlotLogFileName, formatChildExitDiagnostics } from "../composition/loop/child-exit-diagnostics.js";

function fakeFs(): { appendTextFile: (absolutePath: string, text: string) => Promise<void>; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async appendTextFile(absolutePath, text) {
      files.set(absolutePath, (files.get(absolutePath) ?? "") + text);
    },
  };
}

test("childExitSlotLogFileName: sudaro <worker>-<task>-a<attempt>.log ir sanitizuoja kelio separatorius", () => {
  assert.equal(
    childExitSlotLogFileName({ workerId: "w1", taskId: "080-a-02", attemptId: "a1" }),
    "w1-080-a-02-a1.log",
  );
  assert.equal(
    childExitSlotLogFileName({ workerId: "w1/../evil", taskId: "task\\x", attemptId: "a1" }),
    "w1_.._evil-task_x-a1.log",
  );
});

test("childExitSlotLogFileName: trūkstamas attemptId gauna stabilų fallback, ne 'undefined'", () => {
  const name = childExitSlotLogFileName({ workerId: "w1", taskId: "task-1" });
  assert.equal(name, "w1-task-1-a0.log");
});

test("appendChildExitSlotLog: du exit'ai to paties worker/task/attempt sukaupia abu įrašus viename faile", async () => {
  const fs = fakeFs();
  const logged: string[] = [];
  const runtimeRoot = path.join("proj", "vq");
  const input = { workerId: "w1", taskId: "080-a-02", attemptId: "a1" };

  const first = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "boom",
    durationMs: 5,
    workerId: input.workerId,
    taskId: input.taskId,
  });
  const second = formatChildExitDiagnostics({
    code: 2,
    stdout: "",
    stderr: "boom again",
    durationMs: 7,
    workerId: input.workerId,
    taskId: input.taskId,
  });

  await appendChildExitSlotLog({ fs, log: async (message) => void logged.push(message) }, runtimeRoot, input, first);
  await appendChildExitSlotLog({ fs, log: async (message) => void logged.push(message) }, runtimeRoot, input, second);

  const expectedPath = path.join(runtimeRoot, "logs", "slots", "w1-080-a-02-a1.log");
  assert.equal(fs.files.size, 1);
  const content = fs.files.get(expectedPath);
  assert.ok(content !== undefined, "tikimasi vieno failo abiem įrašams");
  assert.match(content, /WAVE SLOT CHILD EXIT 1: slot=w1 task=080-a-02/);
  assert.match(content, /WAVE SLOT CHILD EXIT 2: slot=w1 task=080-a-02/);
  assert.equal(logged.length, 0, "sėkmingas append nesukuria log eilutės");
});

test("appendChildExitSlotLog: SILENT atvejis (be stdout/stderr) irgi patenka į failą", async () => {
  const fs = fakeFs();
  const runtimeRoot = path.join("proj", "vq");
  const input = { workerId: "w2", taskId: "task-silent", attemptId: "a1" };

  const silent = formatChildExitDiagnostics({
    code: 3,
    stdout: "",
    stderr: "",
    durationMs: 1,
    workerId: input.workerId,
    taskId: input.taskId,
  });

  await appendChildExitSlotLog({ fs, log: async () => undefined }, runtimeRoot, input, silent);

  const expectedPath = path.join(runtimeRoot, "logs", "slots", "w2-task-silent-a1.log");
  const content = fs.files.get(expectedPath);
  assert.ok(content !== undefined);
  assert.match(content, /CHILD EXIT SILENT: w2 task-silent/);
});

test("appendChildExitSlotLog: rašymo klaida log'inama, bet nemetama toliau", async () => {
  const logged: string[] = [];
  const failingFs = {
    async appendTextFile(): Promise<void> {
      throw new Error("disk full");
    },
  };
  const runtimeRoot = path.join("proj", "vq");

  await appendChildExitSlotLog(
    { fs: failingFs, log: async (message) => void logged.push(message) },
    runtimeRoot,
    { workerId: "w1", taskId: "task-1", attemptId: "a1" },
    "diagnostics text",
  );

  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /WAVE SLOT CHILD EXIT LOG APPEND FAILED: slot=w1 task=task-1 error=disk full/);
});
