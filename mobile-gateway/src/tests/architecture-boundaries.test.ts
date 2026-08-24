import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

async function readCore(): Promise<ReadonlyArray<readonly [string, string]>> {
  const files = await coreFiles();
  return Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const));
}

/**
 * The AG Loop terminal is external and unmodifiable, so source form is not the
 * boundary: the orchestrator's build output and its workspace package names are
 * the same violation by another route. `ag-ui` is the AG Loop UI app package —
 * this gateway reaches it over loopback HTTP, never by linking it.
 */
const FORBIDDEN_MODULE =
  String.raw`(?:[^"']*orchestrator[\\/](?:src|dist)[^"']*|claude-codex-orchestrator(?:\/[^"']*)?|ag-ui(?:\/[^"']*)?)`;

/** `import x from`, `export … from`, bare `import "…"`, `import()` and `require()`. */
const ORCHESTRATOR_IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["']${FORBIDDEN_MODULE}["']`,
  "i",
);

/**
 * Any quoted reference to those modules, wherever it appears — this is what
 * catches `const spec = "…"; await import(spec)`, `createRequire(...)(spec)`
 * and a hand-built path. A specifier assembled from fragments at runtime stays
 * outside static reach; the import-graph rule is enforced here, not proven.
 */
const ORCHESTRATOR_MODULE_LITERAL = new RegExp(String.raw`["']${FORBIDDEN_MODULE}["']`, "i");

/**
 * Mobile drives only the Claude/Codex session this package spawned. Anything
 * able to signal, kill or feed input to a process the gateway did not create is
 * AG Loop process control, whether or not it names AG Loop.
 */
const AG_LOOP_PROCESS_CONTROL: ReadonlyArray<readonly [string, RegExp]> = [
  ["AG Loop lifecycle entry point", /ensureAgLoopRunning|requestAgLoopStop/],
  ["AG Loop pid or queue control file", /ui-loop\.pid|tasks\/stop|tasks\/resume/],
  // `process.kill` signals a pid the caller need not have spawned; the PTY
  // adapter terminates its own child through node-pty instead.
  ["signal delivery to a foreign pid", /process\.kill\s*\(/],
  // Matches `child.stdin`/`process.stdin`, not the bare word in prose.
  ["stdin of another process", /\.stdin\b/],
  ["out-of-process kill tool", /\btaskkill\b|\bpkill\b/i],
];

/**
 * The files allowed to create OS processes, by construction of the design: Git
 * plumbing, the agent PTY, the provider probe that reads a version and a
 * sign-in state from the very executable the PTY adapter would launch, the
 * GitHub CLI runner — `design.md` §8 makes GitHub a port with named operations,
 * and the MVP adapter answers them by running the operator's already
 * authenticated `gh` with a fixed argument vector — and the quality gate
 * runner.
 *
 * The gate runner is the fifth owner because `design.md` §7 requires the host
 * to RUN five quality gates before a local integration, and a gate is by
 * definition not a Git command. It launches only absolute, host-configured
 * executables with a fixed argument vector, inherits none of the operator's
 * environment and discards the child's output entirely — the gateway learns the
 * exit code and nothing more.
 */
const PROCESS_SPAWN_OWNERS = [
  "gh-cli-runner.ts",
  "host-cli-agent-provider-probe.ts",
  "node-gate-command-runner.ts",
  "node-git-runner.ts",
  "node-pty-direct-agent-terminal-adapter.ts",
];
const PROCESS_SPAWN_MODULE = /["'](?:node:)?child_process["']|["']node-pty["']/;

/**
 * Provider detection and Git plumbing run fixed argument vectors. A shell would
 * turn any string that ever reaches an argument — a voice transcript included —
 * into an execution surface, so no core file may open one.
 */
const SHELL_EXECUTION = /shell:\s*(?:true|["'])|\bexecSync\s*\(|\bspawnSync\s*\(|["'][^"']*\/bin\/sh["']|\bcmd\.exe\b/;

test("mobile gateway never imports orchestrator internals", async () => {
  for (const file of await sourceFiles(sourceRoot)) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, ORCHESTRATOR_IMPORT, file);
  }
});

test("gateway core holds no reference to an orchestrator module", async () => {
  for (const [file, text] of await readCore()) {
    assert.doesNotMatch(text, ORCHESTRATOR_MODULE_LITERAL, file);
  }
});

test("gateway core has no AG Loop process-control implementation", async () => {
  const text = (await readCore()).map(([, content]) => content).join("\n");
  for (const [reason, pattern] of AG_LOOP_PROCESS_CONTROL) {
    assert.doesNotMatch(text, pattern, reason);
  }
});

test("gateway core creates processes only through the git runner and the PTY adapter", async () => {
  const spawners = (await readCore())
    .filter(([, text]) => PROCESS_SPAWN_MODULE.test(text))
    .map(([file]) => path.basename(file))
    .sort();
  assert.deepEqual(spawners, PROCESS_SPAWN_OWNERS);
});

test("the gate runner never reads its child's output", async () => {
  const file = path.join(sourceRoot, "infrastructure/node-gate-command-runner.ts");
  const text = await readFile(file, "utf8");
  assert.match(text, /stdio:\s*["']ignore["']/, file);
  assert.doesNotMatch(text, /\bstdout\b|\bstderr\b/, file);
});

test("gateway core never executes through a shell", async () => {
  for (const [file, text] of await readCore()) {
    assert.doesNotMatch(text, SHELL_EXECUTION, file);
  }
});

test("the host process-table port exposes no way to touch a process", async () => {
  const file = path.join(sourceRoot, "application/ports/process-identity-port.ts");
  const text = await readFile(file, "utf8");
  const declaration = text.slice(text.indexOf("export interface ProcessIdentityPort"));
  assert.match(declaration, /identify\s*\(/);
  assert.doesNotMatch(declaration, /\b(?:kill|signal|attach|terminate|stop|write|send)\s*\(/, file);
});

test("the direct agent terminal port can only start a gateway-owned session", async () => {
  const file = path.join(sourceRoot, "application/ports/direct-agent-terminal-port.ts");
  const text = await readFile(file, "utf8");
  const declaration = text.slice(text.indexOf("export interface DirectAgentTerminalPort"));
  assert.match(declaration, /start\s*\(/);
  assert.doesNotMatch(declaration, /\b(?:attach|adopt|reattach|connect|fromPid)\s*\(/, file);
});

/**
 * Host I/O of any kind. The bind policy and the bootstrap decide whether a
 * phone-facing socket may exist; if either could read the filesystem, ask the
 * operating system for interfaces or open a socket itself, the decision and its
 * execution would live in the same place and no test could hold them apart.
 */
const HOST_IO_MODULE =
  /["'](?:node:)?(?:fs|fs\/promises|os|net|https|http|tls|dgram|child_process)["']/;

test("bind policy and bootstrap stay free of host I/O", async () => {
  for (const relative of ["application/bind-address-policy.ts", "application/host-bootstrap.ts"]) {
    const file = path.join(sourceRoot, relative);
    assert.doesNotMatch(await readFile(file, "utf8"), HOST_IO_MODULE, file);
  }
});

test("the AG Loop UI adapter reads and never mutates", async () => {
  const file = path.join(sourceRoot, "infrastructure/ag-loop-ui-http-adapter.ts");
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i, file);
});

/**
 * PAPILDYMAS (VERQESTRA, ne etalonas): failo dydžio vartas.
 *
 * `src/tests/architecture-gates.test.ts` saugo tik `D:\VERQESTRA\src`, tad be šio testo
 * atskiras workspace paketas liktų be ≤500 eilučių ribos — o būtent dėl jos šio paketo
 * `remote-gateway-router.ts` (etalone 1319 eil.) buvo skaidytas. Riba, kurios niekas nebėga,
 * per pirmą sunkų failą virsta rekomendacija.
 */
const MAX_FILE_LINES = 500;

/** Ta pati skaičiuoklė kaip `src/tests/architecture-gates.test.ts`: baigiamasis LF — ne eilutė. */
function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

test("no gateway source file exceeds the size gate", async () => {
  const oversized: string[] = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const lines = countLines(await readFile(file, "utf8"));
    if (lines > MAX_FILE_LINES) {
      oversized.push(`${path.relative(packageRoot, file)}: ${lines}`);
    }
  }
  assert.deepEqual(oversized, [], `files over ${MAX_FILE_LINES} lines`);
});
