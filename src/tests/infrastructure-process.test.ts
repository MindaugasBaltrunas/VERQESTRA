// Spawn runner'io integraciniai testai (E4 VQ-401) — realūs Node vaikai per
// process.execPath (jokių shell priklausomybių, veikia visose platformose).

import assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessAlive } from "../infrastructure/process/process-tree.js";
import {
  packageManagerExecutable,
  run,
  runWithInput,
  shellInvocationForPlatform,
} from "../infrastructure/process/run-process.js";

const node = process.execPath;

test("run: exit kodas, stdout ir stderr surenkami atskirai", async () => {
  const result = await run(node, ["-e", "console.log('išvestis'); console.error('klaida'); process.exit(3)"]);
  assert.equal(result.code, 3);
  assert.match(result.stdout, /išvestis/);
  assert.match(result.stderr, /klaida/);
  assert.equal(result.stdoutTruncated, false);
});

test("run: timeout nužudo medį ir grąžina 124 su žinute", async () => {
  const result = await run(node, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 500 });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out after 1s|timed out after 0s/);
});

test("run: maxOutputBytes apkarpo head+tail su markeriu", async () => {
  const result = await run(node, ["-e", "process.stdout.write('x'.repeat(50000))"], { maxOutputBytes: 1000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.match(result.stdout, /\[stdout truncated; retained first 200 bytes and last 800 bytes\]/);
});

test("runWithInput: stdin paduodamas vaikui, onStdout stebi chunk'us", async () => {
  const seen: string[] = [];
  const result = await runWithInput(
    node,
    ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
    "labas per stdin",
    process.cwd(),
    undefined,
    undefined,
    { onStdout: (chunk) => seen.push(chunk.toString("utf8")) },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /labas per stdin/);
  assert.match(seen.join(""), /labas per stdin/);
});

test("abort signalas nutraukia procesą su kvietėjo exit kodu ir priežastimi", async () => {
  const controller = new AbortController();
  const pending = run(node, ["-e", "setTimeout(() => {}, 30000)"], {
    abort: { signal: controller.signal, exitCode: 87, reason: "biudžetas išsemtas" },
  });
  setTimeout(() => controller.abort(), 200);
  const result = await pending;
  assert.equal(result.code, 87);
  assert.match(result.stderr, /biudžetas išsemtas/);
});

test("gryni pagalbininkai: shell invokacija pagal platformą ir .cmd priesaga", () => {
  assert.deepEqual(shellInvocationForPlatform("echo x", "linux"), { command: "sh", args: ["-lc", "echo x"] });
  assert.deepEqual(shellInvocationForPlatform("echo x", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "echo x"],
  });
  assert.equal(packageManagerExecutable("pnpm", "win32"), "pnpm.cmd");
  assert.equal(packageManagerExecutable("pnpm.CMD", "win32"), "pnpm.CMD");
  assert.equal(packageManagerExecutable("pnpm", "linux"), "pnpm");
  assert.throws(() => packageManagerExecutable("  "), /required/);
});

test("isProcessAlive: savas procesas gyvas", () => {
  assert.equal(isProcessAlive(process.pid), true);
});
