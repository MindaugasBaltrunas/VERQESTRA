import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HostCliAgentProviderProbe,
  parseAgentProviderVersion,
  type AgentProviderCliProfiles,
  type AgentProviderCommandResult,
  type HostCliAgentProviderProbeDependencies,
} from "../infrastructure/host-cli-agent-provider-probe.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): antra `agent-provider-connection.test.ts` pusė.
 *
 * Čia — hosto ZONDAS: kokia komanda paleidžiama, kaip iš banerio išlukštenama versija, kur
 * ieškoma kredencialo ir kokia hosto konfigūracija atmetama. Servisas (kešas, TTL, `busy`)
 * liko `agent-provider-connection.test.ts`. Abu turi savo fikstūrą, ir nė viena jų nenaudoja
 * kito.
 */

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const sourceRoot = path.join(packageRoot, "src");

const HOME = path.resolve(path.join(path.sep, "home", "operator"));

type RunCall = Readonly<{ executable: string; args: readonly string[]; timeoutMs: number }>;

/** Records every host command instead of running one. */
function recordingRunner(
  responses: (call: RunCall) => AgentProviderCommandResult,
): { calls: RunCall[]; run: (executable: string, args: readonly string[], timeoutMs: number) => Promise<AgentProviderCommandResult> } {
  const calls: RunCall[] = [];
  return {
    calls,
    async run(executable, args, timeoutMs) {
      const call = { executable, args, timeoutMs };
      calls.push(call);
      return responses(call);
    },
  };
}

const TEST_PROFILES: AgentProviderCliProfiles = Object.freeze({
  "claude-code": Object.freeze({
    versionArgs: Object.freeze(["--version"]),
    credentialEnvNames: Object.freeze(["ANTHROPIC_API_KEY"]),
    credentialFiles: Object.freeze([".claude/.credentials.json"]),
  }),
  codex: Object.freeze({
    versionArgs: Object.freeze(["--version"]),
    statusArgs: Object.freeze(["login", "status"]),
    credentialFiles: Object.freeze([".codex/auth.json"]),
  }),
});

function hostProbe(
  overrides: {
    missing?: ReadonlySet<string>;
    run?: (executable: string, args: readonly string[], timeoutMs: number) => Promise<AgentProviderCommandResult>;
    environment?: NodeJS.ProcessEnv;
    existingPaths?: ReadonlySet<string>;
  } = {},
): HostCliAgentProviderProbe {
  const missing = overrides.missing ?? new Set<string>();
  const existing = overrides.existingPaths ?? new Set<string>();
  return new HostCliAgentProviderProbe({
    profiles: TEST_PROFILES,
    environment: overrides.environment ?? {},
    homeDirectory: HOME,
    async resolveExecutable(executable) {
      if (missing.has(executable)) throw new Error("Configured direct agent executable is unavailable");
      return path.join(HOME, "bin", executable);
    },
    run: overrides.run ?? (async () => ({ exitCode: 0, output: "" })),
    async pathExists(absolutePath) {
      return existing.has(absolutePath);
    },
  });
}

test("an executable the host cannot resolve is absent, and nothing is executed", async () => {
  const runner = recordingRunner(() => ({ exitCode: 0, output: "1.2.3" }));
  const probe = hostProbe({ missing: new Set(["claude"]), run: runner.run });
  assert.deepEqual(await probe.detectInstallation("claude-code"), { present: false });
  assert.deepEqual(runner.calls, []);
});

test("the version probe runs the resolved executable with host-fixed arguments", async () => {
  const runner = recordingRunner(() => ({ exitCode: 0, output: "1.2.3 (Claude Code)" }));
  const probe = hostProbe({ run: runner.run });

  assert.deepEqual(await probe.detectInstallation("claude-code"), { present: true, version: "1.2.3" });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.executable, path.join(HOME, "bin", "claude"));
  assert.deepEqual(runner.calls[0]?.args, ["--version"]);
  assert.ok((runner.calls[0]?.timeoutMs ?? 0) > 0, "a host probe must not be able to hang forever");
});

test("an unreadable version leaves the provider installed rather than missing", async () => {
  for (const result of [
    { exitCode: 1, output: "1.2.3" },
    { exitCode: 0, output: "an update is available" },
    { output: "" },
  ] satisfies AgentProviderCommandResult[]) {
    const probe = hostProbe({ run: async () => result });
    assert.deepEqual(await probe.detectInstallation("claude-code"), { present: true }, JSON.stringify(result));
  }
});

test("only a version number is forwarded, never the rest of the CLI banner", async () => {
  const banner = "claude 1.2.3 installed at /home/operator/.local/bin/claude (token abc123)";
  const probe = hostProbe({ run: async () => ({ exitCode: 0, output: banner }) });
  const installation = await probe.detectInstallation("claude-code");
  assert.deepEqual(installation, { present: true, version: "1.2.3" });
  assert.doesNotMatch(JSON.stringify(installation), /home|operator|token|abc123/i);
});

test("version parsing accepts a pre-release and refuses a partial number", () => {
  assert.equal(parseAgentProviderVersion("codex-cli 0.9.1-beta.2"), "0.9.1-beta.2");
  assert.equal(parseAgentProviderVersion("version 2.1"), undefined);
  assert.equal(parseAgentProviderVersion(`${"x".repeat(600)} 1.2.3`), undefined);
});

test("a CLI that answers the sign-in question is believed", async () => {
  const signedIn = recordingRunner(() => ({ exitCode: 0, output: "Logged in as operator" }));
  assert.deepEqual(await hostProbe({ run: signedIn.run }).detectAuthentication("codex"), {
    state: "authenticated",
  });
  assert.deepEqual(signedIn.calls.at(-1)?.args, ["login", "status"]);

  const signedOut = await hostProbe({
    run: async () => ({ exitCode: 1, output: "Not logged in" }),
  }).detectAuthentication("codex");
  assert.deepEqual(signedOut, { state: "unauthenticated", reasonCode: "cli_reports_signed_out" });
});

test("a sign-in check that cannot run falls back to configured credential presence", async () => {
  const unrunnable = async (): Promise<AgentProviderCommandResult> => ({ output: "" });
  const credentialFile = path.join(HOME, ".codex", "auth.json");

  assert.deepEqual(
    await hostProbe({ run: unrunnable, existingPaths: new Set([credentialFile]) })
      .detectAuthentication("codex"),
    { state: "authenticated" },
  );
  assert.deepEqual(await hostProbe({ run: unrunnable }).detectAuthentication("codex"), {
    state: "unauthenticated",
    reasonCode: "no_host_credential",
  });
});

test("credential presence is evidence, and the credential value never reaches the result", async () => {
  const environment = { ANTHROPIC_API_KEY: "sk-ant-super-secret" };
  const result = await hostProbe({ environment }).detectAuthentication("claude-code");
  assert.deepEqual(result, { state: "authenticated" });
  assert.doesNotMatch(JSON.stringify(result), /sk-ant|secret/i);

  assert.deepEqual(await hostProbe({ environment: { ANTHROPIC_API_KEY: "" } }).detectAuthentication("claude-code"), {
    state: "unauthenticated",
    reasonCode: "no_host_credential",
  });
});

test("a credential file is only tested for existence, under the host home directory", async () => {
  const seen: string[] = [];
  const probe = new HostCliAgentProviderProbe({
    profiles: TEST_PROFILES,
    environment: {},
    homeDirectory: HOME,
    async resolveExecutable(executable) {
      return path.join(HOME, "bin", executable);
    },
    async run() {
      return { output: "" };
    },
    async pathExists(absolutePath) {
      seen.push(absolutePath);
      return false;
    },
  });

  await probe.detectAuthentication("claude-code");
  assert.deepEqual(seen, [path.join(HOME, ".claude", ".credentials.json")]);
});

test("a provider without any host check reports an unknown state rather than guessing", async () => {
  const probe = new HostCliAgentProviderProbe({
    profiles: Object.freeze({
      "claude-code": Object.freeze({ versionArgs: Object.freeze(["--version"]) }),
      codex: Object.freeze({ versionArgs: Object.freeze(["--version"]) }),
    }),
    environment: {},
    homeDirectory: HOME,
    async resolveExecutable(executable) {
      return path.join(HOME, "bin", executable);
    },
    async run() {
      return { exitCode: 0, output: "1.2.3" };
    },
    async pathExists() {
      return false;
    },
  });
  assert.deepEqual(await probe.detectAuthentication("claude-code"), {
    state: "unknown",
    reasonCode: "no_host_check_available",
  });
});

test("host configuration that could widen the executed surface is refused", () => {
  const versionOnly = { versionArgs: ["--version"] };
  const cases: ReadonlyArray<readonly [string, HostCliAgentProviderProbeDependencies]> = [
    ["relative path executable", { executables: { "claude-code": "../claude", codex: "codex" } }],
    ["newline in executable", { executables: { "claude-code": "claude\ncodex", codex: "codex" } }],
    ["empty argument vector", { profiles: { "claude-code": { versionArgs: [] }, codex: versionOnly } }],
    ["newline in argument", {
      profiles: { "claude-code": { versionArgs: ["--version\nrm -rf /"] }, codex: versionOnly },
    }],
    ["credential path escaping the home directory", {
      profiles: {
        "claude-code": { ...versionOnly, credentialFiles: [`..${path.sep}..${path.sep}etc`] },
        codex: versionOnly,
      },
    }],
    ["absolute credential path", {
      profiles: {
        "claude-code": { ...versionOnly, credentialFiles: [path.resolve(path.sep, "etc", "shadow")] },
        codex: versionOnly,
      },
    }],
  ];
  for (const [label, dependencies] of cases) {
    assert.throws(
      () => new HostCliAgentProviderProbe({ environment: {}, homeDirectory: HOME, ...dependencies }),
      /is invalid/,
      label,
    );
  }
});

/**
 * `design.md` §14: the phone never receives a provider credential. That holds
 * only while the port has no field shaped like one, which is asserted on the
 * declaration itself rather than on any single adapter.
 */
test("the agent provider probe port surfaces no credential material", async () => {
  const file = path.join(sourceRoot, "application/ports/agent-provider-probe-port.ts");
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(
    text,
    /^\s*(?:readonly\s+)?[A-Za-z]*(?:token|secret|password|credential)[A-Za-z]*\??:/im,
    file,
  );
});

test("the agent provider probe port takes a provider and nothing a client controls", async () => {
  const file = path.join(sourceRoot, "application/ports/agent-provider-probe-port.ts");
  const text = await readFile(file, "utf8");
  const declaration = text.slice(text.indexOf("export interface AgentProviderProbePort"));
  const methods = [...declaration.matchAll(/^ {2}(\w+)\(([^)]*)\)/gm)];
  assert.equal(methods.length, 2, "the port declaration must be parsed, not silently skipped");
  for (const [, name, parameters] of methods) {
    assert.equal(parameters, "provider: AgentProvider", `${name} must take only a provider`);
  }
});
