import assert from "node:assert/strict";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import {
  LOCAL_CONTROL_ERROR_CODES,
  LocalControlError,
  type LocalControlErrorCode,
} from "../application/local-control-errors.js";
import { assertLocalGitArgv } from "../application/local-git-argv-policy.js";
import {
  assertLoopbackHost,
  assertLocalPeerTrusted,
  resolveLocalControlEndpoint,
} from "../application/local-peer-policy.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import {
  GATEWAY_ERROR_CODES,
  GATEWAY_RECOVERABLE_BY_CODE,
  GATEWAY_ROUTE_SURFACE,
  GATEWAY_STATUS_BY_CODE,
  RemoteGatewayRouter,
  type GatewayErrorCode,
} from "../interfaces/http/remote-gateway-router.js";
import {
  LOCAL_CONTROL_ROUTE_SURFACE,
  RECOVERABLE_BY_CODE as LOCAL_RECOVERABLE_BY_CODE,
  STATUS_BY_CODE as LOCAL_STATUS_BY_CODE,
} from "../interfaces/http/local-control-router.js";
import {
  attestation,
  everyLocalRoute,
  inMemoryDeviceAuthState,
  SOURCE_COMMIT,
} from "./local-control-doubles.js";

/**
 * `local-control-contract.md`: "Remote listener does not register any
 * `/v1/local/**` path."
 *
 * The two surfaces are asserted to be disjoint from both directions — the
 * declared route lists and the live remote router — because a contract test on
 * the declaration alone would still pass if someone added a matcher the
 * declaration never mentioned.
 */

test("the remote surface declares no local path", () => {
  for (const route of GATEWAY_ROUTE_SURFACE) {
    assert.equal(route.template.startsWith("/v1/local"), false, route.template);
  }
  for (const route of LOCAL_CONTROL_ROUTE_SURFACE) {
    assert.ok(route.template.startsWith("/v1/local/"), route.template);
  }
  const remote = new Set(GATEWAY_ROUTE_SURFACE.map((route) => `${route.method} ${route.template}`));
  for (const route of LOCAL_CONTROL_ROUTE_SURFACE) {
    assert.equal(remote.has(`${route.method} ${route.template}`), false, route.template);
  }
});

test("the remote router answers 404 for every local path", async () => {
  const router = new RemoteGatewayRouter({
    deviceAuth: new DeviceAuthService(inMemoryDeviceAuthState()),
    audit: new InMemoryAuditLog(),
  });
  for (const route of everyLocalRoute()) {
    const response = await router.handle({
      method: "POST",
      path: route.path,
      headers: { "content-type": "application/json" },
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
      remoteAddress: "203.0.113.7",
    });
    assert.equal(response.status, 404, route.path);
  }
});

/**
 * Codes the remote envelope has and the local surface must never speak. They are
 * the concrete half of "the two vocabularies are not one list": a phone-facing
 * concept — a project, a busy host, the AG Loop UI, a terminal lease, a replay
 * window — has no meaning on a channel that serves the OS owner.
 */
const REMOTE_ONLY_CODES = [
  "project_not_found",
  "host_busy",
  "ag_loop_ui_offline",
  "stale_terminal_lease",
  "history_truncated",
];

/**
 * Codes the local surface speaks and the remote enum does not. Empty today —
 * every current local spelling happens to exist remotely as well — and pinned
 * as a list precisely so that it does not have to stay that way.
 *
 * Growing this list is a legitimate, deliberate one-line edit of THIS file. It
 * does NOT require touching `GATEWAY_ERROR_CODES`, which is the versioned
 * `ErrorEnvelope` enum of the published OpenAPI document: `local-control-errors.ts`
 * says the local vocabulary "must be able to move without touching the published
 * one, and it must not be able to grow the remote enum by accident", and this
 * anchor is what makes that affordable rather than merely stated.
 */
const LOCAL_ONLY_CODES: readonly string[] = [];

test("the local error vocabulary is its own, not an extension of the remote enum", () => {
  // WHY THIS IS NOT A SUBSET ASSERTION — do not "simplify" it back into one.
  //
  // Requiring every local code to appear in `GATEWAY_ERROR_CODES` inverts the
  // invariant this file exists to hold. It would make the first local-only code
  // a red test, and the cheapest way to green it would be to add that code to
  // the PUBLISHED remote enum — a versioned API change for every paired phone,
  // forced by a private channel that the OpenAPI document deliberately excludes.
  // The local surface must be free to move on its own.
  //
  // What is really worth defending is stated in three parts below: the two lists
  // agree wherever they overlap, each side keeps codes the other cannot produce,
  // and neither side is the other.
  const remoteCodes = new Set<string>(GATEWAY_ERROR_CODES);
  const localCodes: readonly string[] = LOCAL_CONTROL_ERROR_CODES;

  // 1. THE INTERSECTION ONLY: a shared spelling must mean one thing. Comparing
  //    the routers' own tables is what makes this a statement about behaviour —
  //    a `conflict` answered 409-and-retryable here and something else there
  //    would be one word with two meanings, which is what forces a translation
  //    table on every transport.
  const shared = localCodes.filter((code) => remoteCodes.has(code));
  assert.ok(shared.length > 0, "the two surfaces are expected to share vocabulary");
  for (const code of shared) {
    const local = code as LocalControlErrorCode;
    const remote = code as GatewayErrorCode;
    assert.equal(LOCAL_STATUS_BY_CODE[local], GATEWAY_STATUS_BY_CODE[remote], code);
    assert.equal(LOCAL_RECOVERABLE_BY_CODE[local], GATEWAY_RECOVERABLE_BY_CODE[remote], code);
  }

  // 2. The local-only half, pinned. A new local code that the remote enum does
  //    not carry is legal: add it to `LOCAL_ONLY_CODES` above and nowhere else.
  assert.deepEqual(
    localCodes.filter((code) => !remoteCodes.has(code)),
    [...LOCAL_ONLY_CODES],
    "a local-only code is legitimate: add it to LOCAL_ONLY_CODES, never to GATEWAY_ERROR_CODES",
  );

  // 3. The remote enum still carries codes the local channel can never produce —
  //    a project, a busy host, the AG Loop UI, a terminal lease, a replay window
  //    are all phone-facing concepts — so the local list cannot silently become
  //    a copy of it, and the two lists are therefore never equal.
  for (const code of REMOTE_ONLY_CODES) {
    assert.ok(remoteCodes.has(code), code);
    assert.equal(localCodes.includes(code), false, code);
  }
  assert.notDeepEqual([...LOCAL_CONTROL_ERROR_CODES], [...GATEWAY_ERROR_CODES]);
});

test("the local Git allowlist refuses every destructive vector", () => {
  const forbidden: ReadonlyArray<readonly string[]> = [
    ["push", "origin", "main"],
    ["reset", "--hard", "HEAD~1"],
    ["clean", "-fd"],
    ["checkout", "main"],
    ["switch", "main"],
    ["rebase", "main"],
    ["cherry-pick", SOURCE_COMMIT],
    ["branch", "-D", "mobile/session"],
    ["update-ref", "refs/heads/main", SOURCE_COMMIT],
    ["worktree", "remove", "/sessions/one"],
    ["worktree", "prune"],
    ["diff", "--force"],
    ["merge", "-f", SOURCE_COMMIT],
  ];
  for (const args of forbidden) {
    for (const mode of ["read", "integrate"] as const) {
      assert.throws(
        () => assertLocalGitArgv(args, mode),
        (error: unknown) => error instanceof LocalControlError && error.code === "internal_error",
        `${mode}: ${args.join(" ")}`,
      );
    }
  }
});

test("the merge vector is allowed only in integrate mode and only in its exact form", () => {
  const merge = ["merge", "--no-ff", "--no-edit", SOURCE_COMMIT];
  assert.doesNotThrow(() => assertLocalGitArgv(merge, "integrate"));
  assert.doesNotThrow(() => assertLocalGitArgv(["merge", "--abort"], "integrate"));
  assert.throws(() => assertLocalGitArgv(merge, "read"));
  assert.throws(() => assertLocalGitArgv(["merge", "--abort"], "read"));
  assert.throws(() => assertLocalGitArgv(["merge", "--no-ff", SOURCE_COMMIT], "integrate"));
  assert.throws(() => assertLocalGitArgv(["merge", "--no-ff", "--no-edit", "main"], "integrate"));

  for (const read of [
    ["rev-parse", "--verify", "HEAD^{commit}"],
    ["symbolic-ref", "--short", "HEAD"],
    ["status", "--porcelain"],
    ["diff", "--name-only", `${SOURCE_COMMIT}...${SOURCE_COMMIT}`],
    ["rev-list", "--parents", "-n", "1", "HEAD"],
    ["worktree", "list"],
  ]) {
    assert.doesNotThrow(() => assertLocalGitArgv(read, "read"), read.join(" "));
  }
});

test("peer trust and Host checks refuse everything they cannot prove", () => {
  const strict = { allowCapabilityOnlyAssurance: false };
  assert.doesNotThrow(() => assertLocalPeerTrusted(attestation(), strict));
  for (const weakened of [
    attestation({ assurance: "unverified" }),
    attestation({ endpointOwnerVerified: false }),
    attestation({ secretFileGuarded: false }),
    attestation({ assurance: "capability-only", transport: "named-pipe" }),
    attestation({ assurance: "capability-only", transport: "loopback-http" }),
  ]) {
    assert.throws(
      () => assertLocalPeerTrusted(weakened, strict),
      (error: unknown) => error instanceof LocalControlError && error.code === "forbidden",
    );
  }
  assert.doesNotThrow(() => assertLocalPeerTrusted(
    attestation({ assurance: "capability-only", transport: "loopback-http", peerAddressIsLoopback: true }),
    { allowCapabilityOnlyAssurance: true },
  ));

  for (const host of ["127.0.0.1:8765", "[::1]:8765", "localhost:8765"]) {
    assert.doesNotThrow(() => assertLoopbackHost(host, 8765), host);
  }
  for (const host of [undefined, "127.0.0.1", "127.0.0.1:8766", "gateway.example:8765", "10.0.0.5:8765"]) {
    assert.throws(
      () => assertLoopbackHost(host, 8765),
      (error: unknown) => error instanceof LocalControlError && error.code === "forbidden",
      String(host),
    );
  }
});

test("the endpoint is a pipe on Windows, a socket elsewhere and loopback only on request", () => {
  const pipe = resolveLocalControlEndpoint({ platform: "win32", dataDirectory: "C:/state" });
  assert.equal(pipe.kind, "named-pipe");
  assert.match(
    pipe.kind === "named-pipe" ? pipe.path : "",
    /^\\\\\.\\pipe\\ag-mobile-gateway-local-[0-9a-f]{16}$/,
  );
  assert.deepEqual(
    resolveLocalControlEndpoint({ platform: "win32", dataDirectory: "C:/state" }),
    pipe,
  );
  assert.notDeepEqual(
    resolveLocalControlEndpoint({ platform: "win32", dataDirectory: "C:/other" }),
    pipe,
  );

  const socket = resolveLocalControlEndpoint({
    platform: "linux",
    dataDirectory: "/var/lib/gateway",
    runtimeDirectory: "/run/gateway",
  });
  assert.deepEqual(socket, { kind: "unix-socket", path: "/run/gateway/local-control.sock" });

  assert.throws(
    () => resolveLocalControlEndpoint({ platform: "linux", dataDirectory: `/${"d".repeat(120)}` }),
    (error: unknown) => error instanceof LocalControlError && error.code === "internal_error",
  );

  assert.deepEqual(
    resolveLocalControlEndpoint({
      platform: "linux",
      dataDirectory: "/var/lib/gateway",
      loopbackFallback: { address: "127.0.0.1", port: 8765 },
    }),
    { kind: "loopback-http", address: "127.0.0.1", port: 8765 },
  );
});
