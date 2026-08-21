// VQ-502 (1/6) testai — hook protokolo pamatas: griežtas vs atlaidus payload'o parsinimas
// (fail-closed PreToolUse pusėje), laukų ištraukimas iš skirtingai vadinamų rašymo taikinių,
// sesijos nuotraukos sąjunga, kuri pergyvena changes.log valymą, vienkartinis konteksto blokas
// ir žurnalų rotacija.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  getHookPathField,
  getHookToolName,
  getToolInputField,
  getToolResponse,
  parseHookInput,
  parseHookInputStrict,
  type HookFsPort,
  type HookIo,
} from "../interfaces/hooks/protocol.js";
import {
  mergeSessionChanges,
  parseSessionChangeLines,
  readRecordedSessionChanges,
  recordSessionChanges,
  resetSessionChanges,
  sessionChangedFiles,
  sessionChangesPath,
} from "../interfaces/hooks/session-changes.js";
import {
  DEFAULT_AGENT_SUMMARY,
  hookUserPrompt,
  renderUserPromptContext,
} from "../interfaces/hooks/user-prompt.js";
import { latestStatus, rotateFileByLines } from "../interfaces/hooks/log-rotation.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: HookIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function fakeFs(files: Record<string, string> = {}): { fs: HookFsPort; store: Map<string, string>; dirs: string[] } {
  const store = new Map(Object.entries(files));
  const dirs: string[] = [];
  return {
    store,
    dirs,
    fs: {
      exists: async (p) => store.has(rel(p)),
      readTextFileIfExists: async (p) => store.get(rel(p)),
      writeTextFile: async (p, text) => void store.set(rel(p), text),
      appendTextFile: async (p, text) => void store.set(rel(p), `${store.get(rel(p)) ?? ""}${text}`),
      makeDirectory: async (dir) => void dirs.push(rel(dir)),
    },
  };
}

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

test("parseHookInput vs parseHookInputStrict: atlaidi forma tyli, griežta — pasako kodėl", () => {
  assert.deepEqual(parseHookInput('{"a":1}'), { a: 1 });
  // Atlaidi forma neperskaitytą payload'ą paverčia tuščiu objektu — būtent dėl to PreToolUse
  // guard'ai jos naudoti negali.
  assert.deepEqual(parseHookInput("{ broken"), {});

  const ok = parseHookInputStrict('{"tool_name":"Bash"}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.value : {}, { tool_name: "Bash" });

  const empty = parseHookInputStrict("   ");
  assert.equal(empty.ok ? "" : empty.kind, "empty");

  const broken = parseHookInputStrict("{ broken");
  assert.equal(broken.ok ? "" : broken.kind, "unparseable");

  const array = parseHookInputStrict("[1,2]");
  assert.equal(array.ok ? "" : array.kind, "not_object");
  const nullPayload = parseHookInputStrict("null");
  assert.equal(nullPayload.ok ? "" : nullPayload.kind, "not_object");
});

test("laukų ištraukimas: skirtingi rašymo taikinių vardai, nežinomas — tuščia eilutė", () => {
  assert.equal(getHookPathField({ tool_input: { path: "a.ts" } }), "a.ts");
  assert.equal(getHookPathField({ tool_input: { file_path: "b.ts" } }), "b.ts");
  assert.equal(getHookPathField({ tool_input: { notebook_path: "c.ipynb" } }), "c.ipynb");
  // Nežinomas laukas → "", ir kvietėjas privalo tai laikyti blokuotina būsena, ne švara.
  assert.equal(getHookPathField({ tool_input: { target: "d.ts" } }), "");
  assert.equal(getHookPathField({}), "");

  assert.equal(getToolInputField({ tool_input: { command: "ls" } }, "command"), "ls");
  assert.equal(getToolInputField({ tool_input: { command: 42 } }, "command"), "");
  assert.equal(getToolInputField({ tool_input: "nope" }, "command"), "");

  assert.equal(getHookToolName({ tool_name: "Write" }), "Write");
  assert.equal(getHookToolName({ tool_name: 7 }), "");
  assert.deepEqual(getToolResponse({ tool_response: { stdout: "x" } }), { stdout: "x" });
  assert.equal(getToolResponse({}), undefined);
});

// ---------------------------------------------------------------------------
// session-changes
// ---------------------------------------------------------------------------

test("sesijos nuotrauka: sąjunga dedublikuojama ir rikiuojama, tuščios eilutės išmetamos", () => {
  assert.deepEqual(parseSessionChangeLines("b.ts\n\n a.ts \n"), ["b.ts", "a.ts"]);
  assert.deepEqual(mergeSessionChanges(["b.ts"], ["a.ts", " b.ts ", ""]), ["a.ts", "b.ts"]);
  assert.equal(rel(sessionChangesPath(RUNTIME_ROOT)), "vq/logs/session-changes.log");
});

test("recordSessionChanges: kaupia per kelis Stop įvykius, reset atstato", async () => {
  const world = fakeFs();
  await recordSessionChanges(world.fs, RUNTIME_ROOT, ["src/b.ts", "src/a.ts"]);
  await recordSessionChanges(world.fs, RUNTIME_ROOT, ["src/a.ts", "src/c.ts"]);

  assert.deepEqual(await readRecordedSessionChanges(world.fs, RUNTIME_ROOT), ["src/a.ts", "src/b.ts", "src/c.ts"]);

  await resetSessionChanges(world.fs, RUNTIME_ROOT);
  assert.deepEqual(await readRecordedSessionChanges(world.fs, RUNTIME_ROOT), []);
});

test("sessionChangedFiles: nuotrauka PLIUS dabar nešvarūs failai — commit'inusi sesija nerodo 0", async () => {
  const world = fakeFs();
  // Stop hook'as užfiksavo commit'intus failus ir išvalė changes.log — jie lieka tik čia.
  await recordSessionChanges(world.fs, RUNTIME_ROOT, ["src/committed.ts"]);

  const files = await sessionChangedFiles(
    { fs: world.fs, collectChangedFiles: async () => ["src/dirty.ts"] },
    ROOT,
    RUNTIME_ROOT,
  );
  assert.deepEqual(files, ["src/committed.ts", "src/dirty.ts"]);
});

// ---------------------------------------------------------------------------
// user-prompt
// ---------------------------------------------------------------------------

test("renderUserPromptContext: pirmoji sesija ir tęsiama sesija skiriasi", () => {
  const first = renderUserPromptContext({
    previousSessions: 1,
    lastSession: undefined,
    agentSummary: DEFAULT_AGENT_SUMMARY,
  });
  assert.match(first, /\*\*Pirmoji sesija\*\*/);
  assert.ok(!first.includes("Sesijos numeris"));

  const resumed = renderUserPromptContext({
    previousSessions: 12,
    lastSession: "[2026-08-21] SESSION_END — pakeista failų: 3",
    agentSummary: "coder, reviewer",
  });
  assert.match(resumed, /\*\*Sesijos numeris:\*\* 12/);
  assert.match(resumed, /pakeista failų: 3/);
  assert.match(resumed, /\*\*Aktyvus agentai:\*\* coder, reviewer/);
});

test("hookUserPrompt: blokas rodomas TIK kartą per sesiją", async () => {
  const world = fakeFs({
    "vq/logs/session.md": "## Sesija 1\n## Sesija 2\n",
    "vq/logs/history.log": "[t] SESSION_END — pakeista failų: 5\n",
  });
  const first = captureIo();
  assert.equal(
    await hookUserPrompt({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, io: first.io, now: () => new Date(0) }),
    0,
  );
  assert.match(first.out[0] ?? "", /\*\*Sesijos numeris:\*\* 2/);
  assert.match(first.out[0] ?? "", /pakeista failų: 5/);
  assert.ok(world.store.has("vq/logs/.context-shown"));
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /UserPromptSubmit — kontekstas pateiktas/);

  const second = captureIo();
  assert.equal(
    await hookUserPrompt({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, io: second.io, now: () => new Date(0) }),
    0,
  );
  assert.deepEqual(second.out, [], "vėliavos failas neleidžia kartoti bloko");
});

// ---------------------------------------------------------------------------
// log-rotation
// ---------------------------------------------------------------------------

test("latestStatus: laimi PASKUTINĖ eilutė, o be atitikmenų — nepaleista, ne žalia", () => {
  const pass = /PASSED/;
  const fail = /FAILED/;
  assert.equal(latestStatus(["x FAILED", "y PASSED"], pass, fail), "PASSED");
  assert.equal(latestStatus(["y PASSED", "x FAILED"], pass, fail), "FAILED");
  assert.equal(latestStatus(["nieko"], pass, fail), "NOT RUN / UNKNOWN");
  assert.equal(latestStatus([], pass, fail), "NOT RUN / UNKNOWN");
});

test("rotateFileByLines: karpo tik peraugusį failą, nesamas — 0", async () => {
  const world = fakeFs({ "vq/logs/hooks.log": Array.from({ length: 10 }, (_v, i) => `line-${i}`).join("\n") });
  const logPath = path.join(RUNTIME_ROOT, "logs", "hooks.log");

  assert.equal(await rotateFileByLines(world.fs, path.join(RUNTIME_ROOT, "logs", "nera.log"), 5, 2), 0);

  assert.equal(await rotateFileByLines(world.fs, logPath, 20, 5), 10, "po riba — nekarpoma");
  assert.equal(world.store.get("vq/logs/hooks.log")?.split("\n").length, 10);

  assert.equal(await rotateFileByLines(world.fs, logPath, 5, 3), 10);
  assert.deepEqual(world.store.get("vq/logs/hooks.log"), "line-7\nline-8\nline-9\n");
});
