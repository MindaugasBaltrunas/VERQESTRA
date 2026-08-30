// Task 075: `rotateFileByLines` apkarpoma dalis privalo likti pasiekiama, ne dingti — 2026-08-28
// „dirty tree" incidento įrodymai buvo prarasti būtent dėl to, kad rotacija perrašydavo failą
// vietoje. Šie testai tikrina archyvavimą į `<filePath>.1` atskirai nuo bendrų protokolo testų.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { HookFsPort } from "../interfaces/hooks/protocol.js";
import { rotateFileByLines } from "../interfaces/hooks/log-rotation.js";

const ROOT = path.resolve("/repo");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function fakeFs(files: Record<string, string> = {}): { fs: HookFsPort; store: Map<string, string> } {
  const store = new Map(Object.entries(files));
  return {
    store,
    fs: {
      exists: async (p) => store.has(rel(p)),
      readTextFileIfExists: async (p) => store.get(rel(p)),
      writeTextFile: async (p, text) => void store.set(rel(p), text),
      appendTextFile: async (p, text) => void store.set(rel(p), `${store.get(rel(p)) ?? ""}${text}`),
      makeDirectory: async () => undefined,
    },
  };
}

const logPath = path.join(ROOT, "vq", "logs", "hooks.log");
const archivePath = path.join(ROOT, "vq", "logs", "hooks.log.1");

test("rotateFileByLines: nukerpama dalis atsiranda archyve", async () => {
  const world = fakeFs({ "vq/logs/hooks.log": Array.from({ length: 10 }, (_v, i) => `line-${i}`).join("\n") });

  // maxLines=8, keepLines=3 → nukerpama 10-3=7 eilučių, kurios telpa į archyvo ribą (7<=8),
  // tad archyvas dar netrumpinamas — grynas append patikrinimas.
  await rotateFileByLines(world.fs, logPath, 8, 3);

  assert.equal(world.store.get("vq/logs/hooks.log"), "line-7\nline-8\nline-9\n");
  assert.equal(world.store.get("vq/logs/hooks.log.1"), "line-0\nline-1\nline-2\nline-3\nline-4\nline-5\nline-6\n");
});

test("rotateFileByLines: antra rotacija PRIDEDA prie archyvo, o ne perrašo", async () => {
  // maxLines=17, keepLines=10 → kiekviena rotacija nukerpa 18-10=8 eilutes; dvi rotacijos kartu
  // duoda 16 eilučių archyve, kas vis dar <=17 — abi liks, nė viena netrumpinama.
  const world = fakeFs({ "vq/logs/hooks.log": Array.from({ length: 18 }, (_v, i) => `line-${i}`).join("\n") });

  await rotateFileByLines(world.fs, logPath, 17, 10);
  assert.equal(
    world.store.get("vq/logs/hooks.log.1"),
    Array.from({ length: 8 }, (_v, i) => `line-${i}`).join("\n") + "\n",
  );

  world.store.set("vq/logs/hooks.log", Array.from({ length: 18 }, (_v, i) => `next-${i}`).join("\n"));
  await rotateFileByLines(world.fs, logPath, 17, 10);

  const archived = world.store.get("vq/logs/hooks.log.1") ?? "";
  assert.ok(archived.startsWith("line-0\n"), "senas turinys išlieka");
  assert.ok(archived.includes("next-0\n"), "naujas turinys pridedamas");
});

test("rotateFileByLines: peraugęs archyvas trumpinamas ties riba", async () => {
  const world = fakeFs({
    "vq/logs/hooks.log": Array.from({ length: 12 }, (_v, i) => `line-${i}`).join("\n"),
    "vq/logs/hooks.log.1": Array.from({ length: 4 }, (_v, i) => `old-${i}`).join("\n") + "\n",
  });

  // trimmed = 12 - 3 = 9 eilučių (line-0..line-8); archyvas turės 4 + 9 = 13 eilučių > maxLines(5),
  // tad apkarpomas iki paskutinių keepLines(3) eilučių.
  await rotateFileByLines(world.fs, logPath, 5, 3);

  const archived = world.store.get("vq/logs/hooks.log.1") ?? "";
  assert.equal(archived, "line-6\nline-7\nline-8\n", "archyvas apkarpytas iki paskutinių keepLines eilučių");
});

test("rotateFileByLines: nesamas/tuščias failas archyvo negamina", async () => {
  const world = fakeFs({ "vq/logs/hooks.log": "" });

  assert.equal(await rotateFileByLines(world.fs, path.join(ROOT, "vq", "logs", "nera.log"), 5, 2), 0);
  assert.equal(world.store.has("vq/logs/nera.log.1"), false);

  assert.equal(await rotateFileByLines(world.fs, logPath, 5, 2), 0, "tuščias failas nėra klaida, bet ir nekarpomas");
  assert.equal(world.store.has(rel(archivePath)), false);
});

test("rotateFileByLines: failas trumpesnis už maxLines — nekarpoma, archyvas nekuriamas", async () => {
  const world = fakeFs({ "vq/logs/hooks.log": Array.from({ length: 4 }, (_v, i) => `line-${i}`).join("\n") });

  assert.equal(await rotateFileByLines(world.fs, logPath, 10, 3), 4);
  assert.equal(world.store.get("vq/logs/hooks.log"), Array.from({ length: 4 }, (_v, i) => `line-${i}`).join("\n"));
  assert.equal(world.store.has("vq/logs/hooks.log.1"), false);
});
