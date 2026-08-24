import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Node-only source checks: this suite never loads React or React Native, so the
// screens stay verifiable in CI without a device toolchain. Their rendered
// output is covered by the MVC core presenter tests, which is exactly the point
// of keeping the screens free of decisions.
//
// NUKRYPIMAS (kelias, ne taisyklės): `process.cwd()` → `__dirname` (žr. `core-seam.test.ts`).

const shellRoot = path.resolve(__dirname, "..", "..", "src");

async function readShellFile(relative: string): Promise<string> {
  return readFile(path.join(shellRoot, relative), "utf8");
}

const screens = [
  "screens/DashboardScreen.tsx",
  "screens/TasksScreen.tsx",
  "screens/SessionReviewScreen.tsx",
  "screens/ConnectionsScreen.tsx",
  "screens/ProjectsScreen.tsx",
] as const;

test("read-only screens exist and consume View contracts from the core seam", async () => {
  for (const screen of screens) {
    const text = await readShellFile(screen);
    assert.match(text, /from\s+"\.\.\/core"/, `${screen} does not use the core seam`);
    assert.match(text, /ViewProps/, `${screen} does not consume a View contract`);
  }
});

test("read-only screens derive no state of their own", async () => {
  for (const screen of [...screens, "components/ConnectionBanner.tsx"]) {
    const text = await readShellFile(screen);
    // Presenting, reducing and reading are Model/presenter work: a screen that
    // calls them would move business logic out of the MVC core.
    for (const forbidden of [
      "presentDashboard",
      "presentTasks",
      "presentSessionReview",
      "presentConnections",
      "presentProjects",
      "reduceAppState",
      "AgLoopReadController",
      "SessionReviewController",
      "ConnectionsController",
      "ProjectsController",
    ]) {
      assert.ok(!text.includes(forbidden), `${screen} performs core work: ${forbidden}`);
    }
    assert.ok(!text.includes("useState"), `${screen} keeps local state: ${screen}`);
  }
});

test("read-only screens render every placeholder the presenter decides", async () => {
  for (const screen of screens) {
    const text = await readShellFile(screen);
    assert.match(text, /state\.showLoadingPlaceholder/, `${screen} ignores the loading placeholder`);
    // Without this branch a screen renders blank whenever no snapshot arrived
    // (offline or never configured), instead of saying why it is empty.
    assert.match(text, /state\.showUnavailablePlaceholder/, `${screen} would render blank without data`);
    assert.match(text, /state\.unavailableLabel/, `${screen} hardcodes its own placeholder text`);
  }
});

test("the root component renders every read-only space", async () => {
  const app = await readShellFile("App.tsx");

  assert.match(app, /<DashboardScreen\b/);
  assert.match(app, /<TasksScreen\b/);
  assert.match(app, /<SessionReviewScreen\b/);
  assert.match(app, /<ConnectionsScreen\b/);
  assert.match(app, /<ProjectsScreen\b/);
  // The read ports are injected; the shell must not fabricate AG Loop, review,
  // connection or project data of its own.
  assert.match(app, /agLoopReads\?:\s*AgLoopUiReadPort/);
  assert.match(app, /sessionReviewReads\?:\s*SessionReviewReadPort/);
  assert.match(app, /connectionsReads\?:\s*HostConnectionsReadPort/);
  assert.match(app, /projectsReads\?:\s*ProjectsReadPort/);
});

test("the Connections and Projects spaces are reachable even when nothing is wired", async () => {
  const app = await readShellFile("App.tsx");

  // Like the Review space, they carry no control that needs a host, and they
  // state plainly when nothing is wired behind them.
  assert.match(app, /id:\s*"connections"\s*as\s*const/);
  assert.match(app, /id:\s*"projects"\s*as\s*const/);
});

test("the Projects screen selects a project and never mutates one", async () => {
  const screen = await readShellFile("screens/ProjectsScreen.tsx");

  assert.match(screen, /onProjectSelected\(row\.projectId\)/);
  // The one intent the contract carries is selection; a screen reaching for any
  // other project verb would be reaching past the read-only View contract.
  for (const forbidden of ["onCreate", "onBind", "onCheckout", "onDelete"]) {
    assert.ok(!screen.includes(forbidden), `Projects screen offers ${forbidden}`);
  }
});

test("the Connections screen offers no host authorization control", async () => {
  const screen = await readShellFile("screens/ConnectionsScreen.tsx");

  // Connecting, disconnecting and authorizing are host-side actions; a tappable
  // path to any of them would leave the read-only boundary of this space.
  for (const forbidden of ["onConnect", "onDisconnect", "onAuthorize", "Linking", "openURL"]) {
    assert.ok(!screen.includes(forbidden), `Connections screen offers ${forbidden}`);
  }
  assert.ok(!screen.includes("Pressable"), "the Connections screen needs no control of its own");
});

test("the Review space is reachable even when nothing is wired behind it", async () => {
  const app = await readShellFile("App.tsx");

  // Unlike the terminal space, the review space carries no control at all, so
  // hiding it would tell the operator less than the screen itself does.
  assert.match(app, /id:\s*"review"\s*as\s*const/);
  assert.doesNotMatch(app, /sessionReviewReads\s*\?\s*\[Object\.freeze\(\{\s*id:\s*"review"/);
});
