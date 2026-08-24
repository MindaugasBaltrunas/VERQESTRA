import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Node-only source checks: this suite never loads React or React Native, so the
// Agent Terminal screen stays verifiable in CI without a device toolchain. What
// it renders is decided by `presentTerminal`, which the MVC core tests cover —
// these assertions only keep the decisions out of the shell.
//
// NUKRYPIMAS (kelias, ne taisyklės): `process.cwd()` → `__dirname` (žr. `core-seam.test.ts`).

const shellRoot = path.resolve(__dirname, "..", "..", "src");

async function readShellFile(relative: string): Promise<string> {
  return readFile(path.join(shellRoot, relative), "utf8");
}

const screen = "screens/TerminalScreen.tsx";

test("the terminal screen consumes its View contract through the core seam", async () => {
  const text = await readShellFile(screen);

  assert.match(text, /from\s+"\.\.\/core"/);
  assert.match(text, /TerminalViewProps/);
});

test("the terminal screen derives no state and holds no terminal rule", async () => {
  const text = await readShellFile(screen);

  for (const forbidden of [
    "useState",
    "useReducer",
    "presentTerminal",
    "reduceAppState",
    "TerminalController",
    "createMobileAppRuntime",
  ]) {
    assert.ok(!text.includes(forbidden), `${screen} performs core work: ${forbidden}`);
  }
  // Enablement is a presenter decision; a screen recomputing it would let the
  // two disagree about when a lifecycle action is safe.
  assert.ok(!/terminalState|connection\s*===/.test(text), `${screen} re-derives session state`);
});

test("the terminal screen exposes provider choice and every PTY lifecycle action", async () => {
  const text = await readShellFile(screen);

  assert.match(text, /state\.providers\.map/, "provider selection is missing");
  assert.match(text, /onProviderSelected\(option\.provider\)/);
  assert.match(text, /state\.actions\.map/, "lifecycle actions are missing");
  for (const intent of [
    "onStartPressed",
    "onInterruptPressed",
    "onClosePressed",
    "onDetachPressed",
    "onSubmitPressed",
    "onComposerChanged",
  ]) {
    assert.ok(text.includes(intent), `${screen} does not wire ${intent}`);
  }
  // Buttons are enabled by the presenter alone, and disabled ones must really
  // be inert rather than merely dimmed.
  assert.match(text, /disabled=\{!action\.enabled\}/);
  assert.match(text, /disabled=\{!state\.composer\.canSend\}/);
  assert.match(text, /editable=\{state\.composer\.editable\}/);
});

test("the terminal screen virtualises the transcript and shows what is not visible", async () => {
  const text = await readShellFile(screen);

  assert.match(text, /<FlatList/, "the transcript is not virtualised");
  assert.match(text, /keyExtractor=\{\(item\) => item\.key\}/, "rows must use presenter keys");
  for (const windowProp of ["initialNumToRender", "maxToRenderPerBatch", "windowSize"]) {
    assert.ok(text.includes(windowProp), `${screen} leaves the render window unbounded: ${windowProp}`);
  }
  assert.match(text, /state\.historyTruncated/, "truncated host history would be invisible");
  assert.match(text, /state\.hiddenLineCount/, "windowed-away output would be invisible");
  assert.match(text, /state\.emptyLabel/, `${screen} would render blank without output`);
  assert.match(text, /state\.composer\.blockedReason/, "a blocked composer would not say why");
});

test("the terminal screen renders the stream and session status it is given", async () => {
  const statusBar = await readShellFile("components/TerminalStatusBar.tsx");

  assert.match(statusBar, /TerminalConnectionViewState/);
  assert.match(statusBar, /connection\.label/);
  assert.match(statusBar, /connection\.stale/);
  assert.ok(!statusBar.includes("useState"), "the status bar keeps local state");
});

test("the root component wires the terminal space through injected ports only", async () => {
  const app = await readShellFile("App.tsx");

  assert.match(app, /<TerminalScreen\b/);
  assert.match(app, /terminal\?:\s*MobileTerminalPorts/);
  assert.match(app, /createMobileAppRuntime\(\{\s*\.\.\.terminal,\s*dispatch\s*\}\)/);
  // A lifecycle button with no transport behind it would be a dead control.
  assert.match(app, /space === "terminal" && runtime/);
  // The composer draft is view-owned and is handed to the presenter, not to the
  // Model: an unsent command never becomes shared application state.
  assert.match(app, /presentTerminal\(state,\s*\{[\s\S]*?composerDraft[\s\S]*?\}\)/);
});

test("the active worktree branch is read from the controller's own session", async () => {
  const app = await readShellFile("App.tsx");

  // The branch comes straight off the terminal session the controller already
  // holds — never off a process id, and never invented by the shell.
  assert.match(app, /activeBranch:\s*runtime\.controller\.session\?\.branch\s*\?\?\s*null/);
  assert.ok(!/\bpid\b/i.test(app), "App.tsx must not reference a process id as a lock signal");
});
