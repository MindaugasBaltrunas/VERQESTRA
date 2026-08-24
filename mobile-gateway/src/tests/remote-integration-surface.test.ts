import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TERMINAL_STREAM_CLIENT_MESSAGE_TYPES } from "../application/terminal-stream-service.js";

/**
 * Branch integration is local-only, and this file asserts the negative half of
 * that rule: there is no remote way to reach it.
 *
 * `local-control-isolation.test.ts` proves the local flow refuses `rebase` and
 * `cherry-pick` argument vectors, and `api-contract-conformance.test.ts` proves
 * the declared HTTP surface names no integration route. What is left — and what
 * lives here — is the shape of the proof that nothing on the REMOTE side, over
 * either transport, can grow one: the websocket vocabulary is closed, the
 * connection a stream hands out can do three things, the remote import graph
 * never reaches the local integration modules, and the Git integration verbs are
 * named in two production files only.
 */

/**
 * Package root resolved from this module, not from `process.cwd()`: a run
 * started in another workspace package would otherwise scan that package's
 * `src` and pass vacuously.
 */
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const sourceRoot = path.join(packageRoot, "src");

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return nested.flat();
}

/** Production files only: the tests themselves must name what they forbid. */
async function coreFiles(): Promise<string[]> {
  return (await sourceFiles(sourceRoot)).filter((file) => !file.includes(`${path.sep}tests${path.sep}`));
}

function sourceFile(relative: string): string {
  return path.join(sourceRoot, relative);
}

test("the websocket gateway accepts exactly the declared client message types", async () => {
  const text = await readFile(sourceFile("interfaces/websocket/terminal-websocket-gateway.ts"), "utf8");
  const named = new Set<string>();
  for (const match of text.matchAll(/["'](client\.[A-Za-z._-]+)["']/g)) {
    named.add(match[1] as string);
  }
  // Without this the assertion below could only fail by the constant becoming
  // empty too, and a gateway that named nothing would look compliant.
  assert.ok(named.size > 0, "the gateway must name the client messages it accepts");
  // The constant is chained to `asyncapi-contract.yaml` by
  // `asyncapi-contract-conformance.test.ts`, so a `client.integrate` guard the
  // gateway understood but the contract never declared cannot be added quietly:
  // it would have to pass through the published protocol first.
  assert.deepEqual(
    [...named].sort(),
    [...TERMINAL_STREAM_CLIENT_MESSAGE_TYPES].sort(),
  );
});

test("a terminal stream connection can only acknowledge, heartbeat and close", async () => {
  const file = sourceFile("application/terminal-stream-service.ts");
  const text = await readFile(file, "utf8");
  const start = text.indexOf("export type TerminalStreamConnection");
  assert.notEqual(start, -1, "TerminalStreamConnection must be declared here");
  // Bounded at the end of the declaration rather than the end of the file: the
  // service implementation below it is a different subject, and a helper it
  // grows later must not turn this assertion red for the wrong reason.
  const end = text.indexOf("}>;", start);
  assert.notEqual(end, -1, "TerminalStreamConnection must be a closed object type");
  const declaration = text.slice(start, end + 3);
  assert.ok(declaration.length > 0);
  assert.match(declaration, /acknowledge\s*\(/);
  assert.match(declaration, /heartbeat\s*\(/);
  assert.match(declaration, /close\s*\(/);
  assert.doesNotMatch(
    declaration,
    /\b(?:integrate|merge|rebase|cherryPick|command|exec|run|write)\s*\(/,
    file,
  );
});

/** `import x from`, `export … from`, bare `import "…"`, `import()` and `require()`. */
const RELATIVE_SPECIFIER =
  String.raw`(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["'](\.[^"']*)["']`;

/**
 * Every file reachable from `roots` through relative imports.
 *
 * An unresolvable specifier fails the test instead of being skipped: silent
 * truncation is the one way an import-graph assertion can pass while proving
 * nothing.
 */
async function reachableFrom(roots: readonly string[]): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(new RegExp(RELATIVE_SPECIFIER, "g"))) {
      const specifier = match[1] as string;
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
      const isFile = await stat(resolved).then((entry) => entry.isFile(), () => false);
      assert.ok(isFile, `${file} imports ${specifier}, which resolves to no source file`);
      pending.push(resolved);
    }
  }
  return visited;
}

/**
 * The local review flow, by module. Reaching any of these from a phone-facing
 * entry point is the violation — not merely calling one, since an import is
 * already enough for a future handler to call it.
 *
 * The three gate modules are here for a sharper reason than the rest. Running
 * the quality gates executes the repository's own build and test commands on the
 * host, under the operator's account, in a worktree a mobile-driven agent wrote:
 * it is the most consequential thing this package does, and `design.md` §7 gives
 * it to the local operator alone. An import of the service or of its runner from
 * the remote graph would be the first half of a remote trigger for it.
 *
 * PAPILDYMAS (VERQESTRA): `local-control-contract.ts` ir `local-integration-observe.ts` yra
 * skaidymo metu atsiradusios TŲ PAČIŲ modulių dalys. Jei sąrašas jų nevardytų, dalį būtų
 * galima pasiekti iš nuotolinio grafo, o testas liktų žalias — skaidymas būtų tyliai
 * praplėšęs vartus, kuriuos pats turėjo išsaugoti.
 */
const LOCAL_ONLY_MODULES = [
  "gate-command-runner-port.ts",
  "local-control-auth.ts",
  "local-control-contract.ts",
  "local-control-router.ts",
  "local-control-service.ts",
  "local-git-argv-policy.ts",
  "local-integration-observe.ts",
  "local-integration-service.ts",
  "node-gate-command-runner.ts",
  "session-gate-evidence-port.ts",
  "session-gate-service.ts",
];

test("the remote request path never reaches the local integration flow", async () => {
  const graph = await reachableFrom([
    sourceFile("interfaces/http/remote-gateway-router.ts"),
    sourceFile("interfaces/websocket/terminal-websocket-gateway.ts"),
  ]);
  const basenames = new Set([...graph].map((file) => path.basename(file)));
  // A graph that collapsed to its two roots would satisfy any exclusion, so its
  // size and two modules the remote path certainly uses are asserted first.
  assert.ok(graph.size >= 12, `remote import graph collapsed to ${graph.size} files`);
  assert.ok(basenames.has("terminal-supervisor.ts"), "the remote graph must reach the supervisor");
  assert.ok(basenames.has("device-auth-service.ts"), "the remote graph must reach device auth");

  // `GitRunnerPort` is deliberately absent from the list above:
  // `TerminalSupervisor` legitimately imports it and runs
  // `["rev-parse", "--verify", "HEAD^{commit}"]` to pick the base commit for a
  // session worktree. Remote access to Git is bounded by what
  // `assertLocalGitArgv` and the supervisor allow, not by hiding the port, so
  // forbidding it here would be red on landing and wrong on the merits.
  assert.deepEqual(
    LOCAL_ONLY_MODULES.filter((module) => basenames.has(module)),
    [],
  );
});

/**
 * A Git integration verb as a complete string literal. Both quotes are part of
 * the pattern on purpose: `"merged"` — the pull-request state in
 * `infrastructure/gh-cli-git-host-adapter.ts` and
 * `application/ports/git-host-port.ts` — is a GitHub fact this gateway reads,
 * not a command it runs, and must not be dragged in here.
 */
const INTEGRATION_VERB_LITERAL = /["'](?:merge|rebase|cherry-pick|cherry_pick)["']/;
const INTEGRATION_VERB_OWNERS = ["local-git-argv-policy.ts", "local-integration-service.ts"];

/** The blocked command intents, which only the domain's intent table may name. */
const INTEGRATION_INTENT = /git\.integration\.(?:merge|rebase|cherry_pick)/;
const INTEGRATION_INTENT_OWNERS = ["command-intent.ts"];

test("only the local integration files name a Git integration verb", async () => {
  const files = await coreFiles();
  assert.ok(files.length > 0, "the production scan must read something");
  const texts = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const));

  const namesVerb = texts
    .filter(([, text]) => INTEGRATION_VERB_LITERAL.test(text))
    .map(([file]) => path.basename(file))
    .sort();
  assert.deepEqual(namesVerb, INTEGRATION_VERB_OWNERS);

  const namesIntent = texts
    .filter(([, text]) => INTEGRATION_INTENT.test(text))
    .map(([file]) => path.basename(file))
    .sort();
  assert.deepEqual(namesIntent, INTEGRATION_INTENT_OWNERS);
});
