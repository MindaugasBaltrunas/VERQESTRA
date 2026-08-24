import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuditEvent } from "../application/ports/audit-port.js";
import { AppendOnlyAuditFileStore } from "../infrastructure/append-only-audit-file-store.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { AtomicJsonSessionRegistryStore } from "../infrastructure/atomic-json-session-registry-store.js";
import {
  defaultAuditLogFile,
  defaultDeviceAuthStateFile,
  defaultSessionRegistryFile,
  GATEWAY_DATA_DIRECTORY_ENV,
  GATEWAY_DATA_DIRECTORY_NAME,
  GatewayDataDirectoryError,
  hostDataEnvironment,
  resolveGatewayDataDirectory,
  type HostDataEnvironment,
} from "../infrastructure/gateway-data-directory.js";

/**
 * Platform resolution is exercised through a faked environment only: a test that
 * touched the real `%APPDATA%` or `~/.local/share` would write host state from
 * `npm test`. The two cases that do write use a temp directory reached through
 * the operator override.
 */
function environmentOf(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homeDirectory = platform === "win32" ? "C:\\Users\\tester" : "/home/tester",
): HostDataEnvironment {
  return { platform, env, homeDirectory };
}

/**
 * Expectations are built with the *faked* platform's path flavour, so a Windows
 * mapping keeps asserting Windows semantics when the suite runs on Linux.
 */
function expected(platform: NodeJS.Platform, ...segments: string[]): string {
  const flavour = platform === "win32" ? win32 : posix;
  return flavour.resolve(flavour.join(...segments, GATEWAY_DATA_DIRECTORY_NAME));
}

const packageRoot = resolve(fileURLToPath(import.meta.url), "../../../");

function repositoryRootOf(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return dirname(dirname(start));
    current = parent;
  }
}

const projectRoot = repositoryRootOf(packageRoot);

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/** POSIX mode bits are meaningless on Windows, where the ACL of `%APPDATA%` protects the file. */
async function assertMode(path: string, expectedMode: number): Promise<void> {
  if (process.platform === "win32") return;
  assert.equal((await stat(path)).mode & 0o777, expectedMode, path);
}

test("the containment guard is anchored to this package, not to the working directory", () => {
  assert.equal(basename(packageRoot), "mobile-gateway");
  assert.equal(isInside(projectRoot, packageRoot), true);
});

test("windows resolves gateway state under %APPDATA%", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("win32", { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }),
  );
  assert.equal(directory, expected("win32", "C:\\Users\\tester\\AppData\\Roaming"));
});

test("windows falls back to %LOCALAPPDATA% when roaming app data is absent", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("win32", { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }),
  );
  assert.equal(directory, expected("win32", "C:\\Users\\tester\\AppData\\Local"));
});

test("windows falls back to the conventional roaming path when neither variable is set", () => {
  const directory = resolveGatewayDataDirectory(environmentOf("win32", {}));
  assert.equal(directory, expected("win32", "C:\\Users\\tester", "AppData", "Roaming"));
});

test("a roaming share is passed over for any local volume the profile offers", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("win32", {
      APPDATA: "\\\\fileserver\\profiles\\tester\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    }),
  );
  assert.equal(directory, expected("win32", "C:\\Users\\tester\\AppData\\Local"));
});

test("a fully roaming profile still resolves, using the non-roaming variable", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("win32", {
      APPDATA: "\\\\fileserver\\profiles\\tester\\AppData\\Roaming",
      LOCALAPPDATA: "\\\\fileserver\\profiles\\tester\\AppData\\Local",
    }),
  );
  assert.equal(directory, expected("win32", "\\\\fileserver\\profiles\\tester\\AppData\\Local"));
});

test("a relative %APPDATA% is ignored instead of being resolved against the cwd", () => {
  const directory = resolveGatewayDataDirectory(environmentOf("win32", { APPDATA: "AppData" }));
  assert.equal(directory, expected("win32", "C:\\Users\\tester", "AppData", "Roaming"));
});

test("macOS resolves gateway state under Application Support", () => {
  const directory = resolveGatewayDataDirectory(environmentOf("darwin", {}));
  assert.equal(directory, expected("darwin", "/home/tester", "Library", "Application Support"));
});

test("linux honours XDG_DATA_HOME", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("linux", { XDG_DATA_HOME: "/var/lib/ag" }),
  );
  assert.equal(directory, expected("linux", "/var/lib/ag"));
});

test("linux ignores a relative XDG_DATA_HOME and uses the XDG default", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("linux", { XDG_DATA_HOME: "relative/data" }),
  );
  assert.equal(directory, expected("linux", "/home/tester", ".local", "share"));
});

test("an absolute operator override replaces the platform directory verbatim", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("linux", { [GATEWAY_DATA_DIRECTORY_ENV]: "/srv/ag-state/gateway/" }),
  );
  assert.equal(directory, "/srv/ag-state/gateway");
});

test("a blank override falls back to the platform directory", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("linux", { [GATEWAY_DATA_DIRECTORY_ENV]: "   " }),
  );
  assert.equal(directory, expected("linux", "/home/tester", ".local", "share"));
});

test("a surrounding-whitespace override is honoured rather than reported as relative", () => {
  const directory = resolveGatewayDataDirectory(
    environmentOf("linux", { [GATEWAY_DATA_DIRECTORY_ENV]: "  /srv/ag-state  " }),
  );
  assert.equal(directory, "/srv/ag-state");
});

test("a relative override is rejected", () => {
  assert.throws(
    () =>
      resolveGatewayDataDirectory(
        environmentOf("linux", { [GATEWAY_DATA_DIRECTORY_ENV]: "./state" }),
      ),
    (error: unknown) =>
      error instanceof GatewayDataDirectoryError && error.reason === "not_absolute",
  );
});

test("a windows override without a drive root is rejected instead of following the current drive", () => {
  assert.throws(
    () =>
      resolveGatewayDataDirectory(
        environmentOf("win32", { [GATEWAY_DATA_DIRECTORY_ENV]: "\\gateway-state" }),
      ),
    (error: unknown) =>
      error instanceof GatewayDataDirectoryError && error.reason === "not_absolute",
  );
});

test("a UNC override is rejected: credentials stay on a local volume", () => {
  for (const unc of ["\\\\fileserver\\share\\gateway", "//fileserver/share/gateway"]) {
    assert.throws(
      () =>
        resolveGatewayDataDirectory(
          environmentOf("win32", { [GATEWAY_DATA_DIRECTORY_ENV]: unc }),
        ),
      (error: unknown) =>
        error instanceof GatewayDataDirectoryError && error.reason === "unsupported_root",
      unc,
    );
  }
});

test("an override anywhere in the repository working tree is rejected", () => {
  const forbidden = [
    join(projectRoot, "AG", "state"),
    join(projectRoot, "AG", "logs"),
    // PAPILDYMAS (VERQESTRA): šio produkto runtime šaknis yra `vq/`, ne `AG/`. Sąrašas su
    // vien `AG/*` VERQESTRA'oje tikrintų kaimyno katalogus ir praleistų tuos, kurie realiai
    // laiko šio repo būseną.
    join(projectRoot, "vq", "state"),
    join(projectRoot, "vq", "logs"),
    join(projectRoot, "gateway-state"),
    projectRoot,
    packageRoot,
    // `..` is collapsed before the check, so a path that leaves the tree only
    // textually cannot re-enter it. Built by concatenation: `join` would
    // normalise the traversal away before the resolver ever saw it.
    `${projectRoot}${sep}..${sep}${basename(projectRoot)}${sep}AG${sep}state`,
  ];
  for (const candidate of forbidden) {
    assert.throws(
      () =>
        resolveGatewayDataDirectory(
          environmentOf(process.platform, { [GATEWAY_DATA_DIRECTORY_ENV]: candidate }),
        ),
      (error: unknown) =>
        error instanceof GatewayDataDirectoryError && error.reason === "inside_project_tree",
      candidate,
    );
  }
});

test("a host without a usable home directory fails loudly", () => {
  assert.throws(
    () => resolveGatewayDataDirectory(environmentOf("linux", {}, "")),
    (error: unknown) =>
      error instanceof GatewayDataDirectoryError && error.reason === "no_home_directory",
  );
});

test("a store cannot be opened against another platform's path layout", () => {
  const foreign = environmentOf(process.platform === "win32" ? "linux" : "win32", {});
  for (const open of [
    () => AtomicJsonDeviceAuthStateStore.inGatewayDataDirectory({ environment: foreign }),
    () => AtomicJsonSessionRegistryStore.inGatewayDataDirectory("gateway-1", foreign),
    () => AppendOnlyAuditFileStore.inGatewayDataDirectory(foreign),
  ]) {
    assert.throws(
      open,
      (error: unknown) =>
        error instanceof GatewayDataDirectoryError && error.reason === "foreign_platform",
    );
  }
});

test("the real host environment never resolves into the project tree", () => {
  const directory = resolveGatewayDataDirectory(hostDataEnvironment());
  assert.equal(isAbsolute(directory), true);
  assert.equal(isInside(projectRoot, directory), false, directory);
});

test("every state file defaults into the application-data directory", () => {
  const environment = environmentOf("linux", { XDG_DATA_HOME: "/var/lib/ag" });
  const directory = resolveGatewayDataDirectory(environment);
  assert.equal(defaultDeviceAuthStateFile(environment), posix.join(directory, "device-auth.json"));
  assert.equal(defaultSessionRegistryFile(environment), posix.join(directory, "sessions.json"));
  assert.equal(defaultAuditLogFile(environment), posix.join(directory, "audit.jsonl"));
});

test("store factories write to the application-data directory and keep their integrity semantics", async () => {
  const base = await mkdtemp(join(tmpdir(), "ag-gateway-data-"));
  const dataDirectory = join(base, GATEWAY_DATA_DIRECTORY_NAME);
  const environment = environmentOf(process.platform, {
    [GATEWAY_DATA_DIRECTORY_ENV]: dataDirectory,
  });
  try {
    const auth = AtomicJsonDeviceAuthStateStore.inGatewayDataDirectory({ environment });
    assert.equal(auth.stateFile, join(dataDirectory, "device-auth.json"));
    const state = await auth.read();
    assert.equal(state.version, 1);
    assert.equal(typeof state.accessSigningKey, "string");
    await assertMode(dataDirectory, 0o700);
    await assertMode(auth.stateFile, 0o600);

    const registry = AtomicJsonSessionRegistryStore.inGatewayDataDirectory("gateway-1", environment);
    assert.equal(registry.registryFile, join(dataDirectory, "sessions.json"));
    const revision = await registry.update((current) => ({
      snapshot: { ...current, revision: current.revision + 1 },
      result: current.revision + 1,
    }));
    assert.equal(revision, 2);
    // Checksum verification still runs on a cold read of the same file.
    const reopened = AtomicJsonSessionRegistryStore.inGatewayDataDirectory("gateway-1", environment);
    assert.equal((await reopened.read()).revision, 2);
    await assertMode(registry.registryFile, 0o600);

    const audit = AppendOnlyAuditFileStore.inGatewayDataDirectory(environment);
    assert.equal(audit.filePath, join(dataDirectory, "audit.jsonl"));
    const event: AuditEvent = {
      eventId: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-08-07T10:00:00.000Z",
      action: "terminal.input",
      outcome: "allowed",
      correlationId: "10000000-0000-4000-8000-000000000001",
      principalId: "20000000-0000-4000-8000-000000000000",
      deviceId: "30000000-0000-4000-8000-000000000000",
    };
    await audit.record(event);
    assert.deepEqual(await audit.verifyChain(), { valid: true, recordCount: 1 });
    await assertMode(audit.filePath, 0o600);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
