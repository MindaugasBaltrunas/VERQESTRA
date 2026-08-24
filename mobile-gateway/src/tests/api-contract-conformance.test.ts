import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeviceAuthService } from "../application/device-auth-service.js";
import { GitHubReadService } from "../application/github-read-service.js";
import type { DirectAgentTerminalPort } from "../application/ports/direct-agent-terminal-port.js";
import type { GitHostPort } from "../application/ports/git-host-port.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectReadService } from "../application/project-read-service.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import {
  GATEWAY_ERROR_CODES,
  GATEWAY_RECOVERABLE_BY_CODE,
  GATEWAY_ROUTE_SURFACE,
  GATEWAY_STATUS_BY_CODE,
  RemoteGatewayRouter,
} from "../interfaces/http/remote-gateway-router.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";

/**
 * NUKRYPIMAS (vieta, ne turinys): kontraktas gyvena paketo viduje, o kelias skaičiuojamas nuo
 * modulio, ne nuo `process.cwd()` — žr. `asyncapi-contract-conformance.test.ts` antraštę.
 * Pats YAML perkeltas baitas į baitą.
 */
const CONTRACT_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../",
  "contracts",
  "api-contract.yaml",
);

/**
 * The OpenAPI `servers` url ends in `/v1`, so contract path keys are declared
 * without it while the router matches the full request target.
 */
const SERVER_BASE_PATH = "/v1";

/**
 * Contract operations that are declared but deliberately not served yet,
 * mirroring the "Not implemented yet" section of `implementation-status.md`.
 *
 * The unit is one method on one path, not the path: `/connections/github`
 * serves a GET while its POST and DELETE remain unimplemented, and a path-level
 * list would have hidden both the moment the GET landed. The list is asserted in
 * both directions: a newly declared operation that nobody implements must be
 * added here consciously, and an operation that becomes implemented must be
 * removed — so "declared but missing" can never pass silently as coverage.
 */
const DEFERRED_CONTRACT_OPERATIONS: readonly string[] = [
  "GET /connections/agents",
  "POST /connections/agents/{provider}",
  "DELETE /connections/agents/{provider}",
  "POST /connections/github",
  "DELETE /connections/github",
  "POST /projects",
  "POST /projects/{projectId}/github/issues/{issueNumber}/import",
  "POST /projects/{projectId}/github/pull-requests",
];

const HTTP_METHOD_KEYS = /^ {4}(get|put|post|delete|patch|head|options|trace):\s*$/;

/**
 * Minimal, purpose-built reader for the two facts this test needs: the declared
 * `METHOD /path` operations and the `ErrorEnvelope` code enum. The package
 * intentionally has no YAML dependency, and a full parser is not required to
 * detect contract drift — path keys sit at two spaces of indentation and their
 * operations at four, which is enough to pair them.
 */
function declaredOperations(contract: string): Set<string> {
  const operations = new Set<string>();
  let inPaths = false;
  let currentPath: string | undefined;
  for (const line of contract.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^\S/.test(line)) break;
    const pathKey = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathKey?.[1]) {
      currentPath = pathKey[1];
      continue;
    }
    const methodKey = HTTP_METHOD_KEYS.exec(line);
    if (methodKey?.[1] && currentPath) {
      operations.add(`${methodKey[1].toUpperCase()} ${currentPath}`);
    }
  }
  return operations;
}

/** Path keys of every declared operation. */
function declaredPaths(contract: string): Set<string> {
  return new Set(
    [...declaredOperations(contract)].map((operation) => operation.slice(operation.indexOf(" ") + 1)),
  );
}

function implementedOperations(): Set<string> {
  return new Set(
    GATEWAY_ROUTE_SURFACE.map(
      (route) => `${route.method} ${route.template.slice(SERVER_BASE_PATH.length)}`,
    ),
  );
}

function declaredErrorCodes(contract: string): string[] {
  const block = /ErrorEnvelope:[\s\S]*?code:\s*\n\s*enum:\n((?:\s*-\s+\w+\n)+)/.exec(contract);
  assert.ok(block?.[1], "api-contract.yaml must declare an ErrorEnvelope code enum");
  return [...block[1].matchAll(/-\s+(\w+)/g)].map((entry) => entry[1] as string);
}

/**
 * GitHub port that must never be reached: every route below is probed without a
 * bearer token, so authentication has to reject the call before any host fact is
 * looked up.
 */
function unreachableGitHostPort(): GitHostPort {
  const unreachable = (): never => {
    throw new Error("no unauthenticated probe may reach the GitHub boundary");
  };
  return {
    connection: unreachable,
    beginAuthorization: unreachable,
    revokeConnection: unreachable,
    binding: unreachable,
    repositoryStatus: unreachable,
    listIssues: unreachable,
    issue: unreachable,
    listPullRequests: unreachable,
    createPullRequest: unreachable,
  };
}

function concreteTarget(template: string): string {
  let index = 0;
  const target = template.replace(/\{[^}]+\}/g, () => {
    index += 1;
    return `123e4567-e89b-42d3-a456-42661417${String(4040 + index).slice(-4)}`;
  });
  // The tasks route requires its allowlisted bucket query to reach the handler.
  return target.endsWith("/ag-loop/ui/tasks") ? `${target}?bucket=queue` : target;
}

test("every implemented route is declared in the OpenAPI contract", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  const operations = declaredOperations(contract);
  assert.ok(operations.size > 0, "api-contract.yaml must declare path operations");
  for (const route of GATEWAY_ROUTE_SURFACE) {
    assert.ok(
      route.template.startsWith(SERVER_BASE_PATH),
      `${route.template} must be served under ${SERVER_BASE_PATH}`,
    );
    const operation = `${route.method} ${route.template.slice(SERVER_BASE_PATH.length)}`;
    assert.ok(
      operations.has(operation),
      `${route.method} ${route.template} is implemented but missing from api-contract.yaml`,
    );
  }
});

test("every declared operation is either implemented or an acknowledged deferral", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  const implemented = implementedOperations();
  const deferred = new Set(DEFERRED_CONTRACT_OPERATIONS);
  const declared = declaredOperations(contract);

  for (const operation of declared) {
    assert.ok(
      implemented.has(operation) || deferred.has(operation),
      `${operation} is declared in api-contract.yaml but neither implemented nor listed as deferred`,
    );
    assert.equal(
      implemented.has(operation) && deferred.has(operation),
      false,
      `${operation} is implemented, so it must be removed from DEFERRED_CONTRACT_OPERATIONS`,
    );
  }

  for (const operation of deferred) {
    assert.ok(
      declared.has(operation),
      `${operation} is listed as deferred but is not declared in the contract`,
    );
  }
  assert.equal(implemented.size + deferred.size, declared.size);
});

test("gateway error codes and the contract error enum stay identical", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  assert.deepEqual(
    [...declaredErrorCodes(contract)].sort(),
    [...GATEWAY_ERROR_CODES].sort(),
  );
});

/**
 * Codes with no HTTP producer at all. `history_truncated` belongs to the
 * terminal stream vocabulary, so no request can be made to elicit it; the tables
 * still have to answer for it, which is why the pin below is literal rather than
 * derived from what a router happens to emit.
 */
const NO_HTTP_PRODUCER: readonly string[] = ["history_truncated"];

/**
 * Codes this file cannot elicit but other files assert against the same tables
 * through `assertEnvelopeMatchesTables`. Named with their file so a code that
 * loses its only live check is visible here rather than silently uncovered:
 *
 * - project_not_found, conflict — `github-http-routes.test.ts`
 * - forbidden, stale_terminal_lease, duplicate_request, host_busy — `remote-gateway-router.test.ts`
 * - session_not_live — `remote-gateway-router.test.ts` (a session the host never had)
 * - ag_loop_ui_offline — `ag-loop-read-routes.test.ts`
 * - rate_limited — `gateway-hardening.test.ts`, `github-http-routes.test.ts`
 * - internal_error — `gateway-hardening.test.ts`, `github-http-routes.test.ts`
 */
const COVERED_ELSEWHERE: readonly string[] = [
  "forbidden",
  "project_not_found",
  "conflict",
  "stale_terminal_lease",
  "duplicate_request",
  "host_busy",
  "session_not_live",
  "ag_loop_ui_offline",
  "rate_limited",
  "internal_error",
];

test("every error code has exactly one status and one recoverable verdict", () => {
  // Pinned literally rather than compared against the router's own behaviour:
  // a table that only agreed with itself would let a status change land silently
  // as long as every caller changed with it.
  assert.deepEqual({ ...GATEWAY_STATUS_BY_CODE }, {
    unauthenticated: 401,
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    project_not_found: 404,
    host_busy: 409,
    stale_terminal_lease: 409,
    duplicate_request: 409,
    session_not_live: 409,
    conflict: 409,
    history_truncated: 409,
    ag_loop_ui_offline: 503,
    rate_limited: 429,
    internal_error: 500,
  });
  assert.deepEqual({ ...GATEWAY_RECOVERABLE_BY_CODE }, {
    unauthenticated: true,
    forbidden: false,
    invalid_request: true,
    not_found: false,
    project_not_found: false,
    host_busy: true,
    stale_terminal_lease: true,
    duplicate_request: false,
    session_not_live: true,
    conflict: true,
    history_truncated: false,
    ag_loop_ui_offline: true,
    rate_limited: true,
    internal_error: true,
  });
  // Completeness becomes structural: a new code cannot be added without a status
  // and a recoverable verdict, and a stale entry cannot outlive its code.
  assert.deepEqual(Object.keys(GATEWAY_STATUS_BY_CODE).sort(), [...GATEWAY_ERROR_CODES].sort());
  assert.deepEqual(Object.keys(GATEWAY_RECOVERABLE_BY_CODE).sort(), [...GATEWAY_ERROR_CODES].sort());
  // Every code is accounted for: elicited in this file, elicited elsewhere, or
  // declared to have no HTTP producer.
  assert.deepEqual(
    [...GATEWAY_ERROR_CODES]
      .filter((code) => !COVERED_ELSEWHERE.includes(code) && !NO_HTTP_PRODUCER.includes(code))
      .sort(),
    ["invalid_request", "not_found", "unauthenticated"],
  );
});

test("the contract exposes no AG Loop process-control or branch-integration route", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  for (const path of declaredPaths(contract)) {
    assert.doesNotMatch(
      path,
      /(?:^|\/)(?:integrate|merge|rebase|cherry-pick)(?:$|\/)|ag-loop\/(?:start|stop|restart|process)/,
      `api-contract.yaml must not declare ${path}`,
    );
  }
  assert.equal(
    GATEWAY_ROUTE_SURFACE.some((route) => /integrate|merge|rebase|ag-loop\/(?:start|stop)/.test(route.template)),
    false,
  );
});

/**
 * Builds the router with every surface wired — AG Loop UI reads, GitHub reads and
 * terminals — and hands it to `run`. All three are present on purpose: a route is
 * conditional on its service, so a partial composition would report a declared
 * route as unrouted instead of as served.
 */
async function withFullySpecifiedRouter(
  run: (router: RemoteGatewayRouter) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-conformance-"));
  try {
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "repository", ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    const membership: ProjectMembershipPort = {
      async canReadProject() {
        return true;
      },
      async canControlTerminal() {
        return true;
      },
    };
    const git: GitRunnerPort = {
      async run() {
        return { exitCode: 0, stdout: "abcdef1234567890\n", stderr: "" };
      },
    };
    const worktrees: WorktreeAllocationPort = {
      async allocate(input) {
        return {
          sessionId: input.sessionId,
          branch: `mobile/${input.sessionId}`,
          baseCommit: input.baseCommit,
          worktreeRoot: join(directory, "sessions", input.sessionId),
        };
      },
    };
    const terminals: DirectAgentTerminalPort = {
      async start() {
        throw new Error("no unauthenticated probe may reach the PTY boundary");
      },
    };
    const gitHost = unreachableGitHostPort();
    const now = () => new Date("2026-07-28T10:00:00.000Z");
    const router = new RemoteGatewayRouter({
      deviceAuth: new DeviceAuthService(
        new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
      ),
      now,
      projectReads: new ProjectReadService(registry, membership, () => undefined),
      github: new GitHubReadService({ registry, membership, gitHost }),
      terminals: new TerminalSupervisor({
        projects: registry,
        git,
        worktrees,
        terminals,
        clock: now,
        leaseTtlMs: 60_000,
      }),
      membership,
      audit: new InMemoryAuditLog(),
    });

    await run(router);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the declared route surface matches the routes the router actually serves", async () => {
  await withFullySpecifiedRouter(async (router) => {
    for (const route of GATEWAY_ROUTE_SURFACE) {
      const response = await router.handle({
        method: route.method,
        path: concreteTarget(route.template),
        headers: { "content-type": "application/json" },
        body: "{}",
        remoteAddress: "198.51.100.42",
      });
      assert.notEqual(
        response.status,
        404,
        `${route.method} ${route.template} is declared but not routed`,
      );
    }

    // Routes the remote surface must not have, probed against the live wiring
    // rather than the declared surface: the route table is one statement of the
    // boundary, and this is the other. The terminal-session paths matter most —
    // those are the ones an integration action would most plausibly be hung off,
    // and the router's own action pattern is what refuses them.
    const project = "123e4567-e89b-42d3-a456-426614174050";
    const session = "123e4567-e89b-42d3-a456-426614174051";
    for (const [method, target] of [
      ["POST", "/v1/ag-loop/stop"],
      ["POST", `/v1/projects/${project}/integrate`],
      ["GET", `/v1/projects/${project}/integrate`],
      ["POST", `/v1/projects/${project}/terminal-sessions/${session}/integrate`],
      ["POST", `/v1/projects/${project}/terminal-sessions/${session}/merge`],
      ["POST", `/v1/projects/${project}/terminal-sessions/${session}/rebase`],
      ["POST", `/v1/projects/${project}/terminal-sessions/${session}/cherry-pick`],
      ["POST", `/v1/projects/${project}/branches/main/merge`],
      ["POST", "/v1/local/pairing-challenges"],
      ["POST", `/v1/devices/${project}/revoke`],
    ] as ReadonlyArray<readonly [string, string]>) {
      const response = await router.handle({ method, path: target });
      assert.equal(response.status, 404, `${method} ${target} must not be routed`);
      // An unknown route is `not_found`, and the live envelope has to agree with
      // the published tables about what that means.
      assert.equal(
        assertEnvelopeMatchesTables(response, `${method} ${target}`),
        "not_found",
        `${method} ${target}`,
      );
    }
  });
});

/**
 * The three remote surfaces this change delivers. Asserting they are all present
 * in the declared route surface is what keeps the envelope test below honest: it
 * iterates the surface, so a surface that quietly lost its GitHub or AG Loop UI
 * routes would still pass every assertion while covering nothing.
 */
const ROUTE_SURFACE_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GitHub", /^\/v1\/(?:connections\/github|projects\/\{projectId\}\/github)$/],
  ["AG Loop UI read", /^\/v1\/projects\/\{projectId\}\/ag-loop\/ui\//],
  ["terminal", /^\/v1\/projects\/\{projectId\}\/terminal-sessions/],
];

/** Routes served to an unauthenticated caller by design. */
const UNAUTHENTICATED_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/pairing-challenges/{challengeId}/redeem",
  "POST /v1/auth/refresh",
]);

test("the route surface carries a GitHub, an AG Loop UI and a terminal family", () => {
  for (const [family, pattern] of ROUTE_SURFACE_FAMILIES) {
    assert.ok(
      GATEWAY_ROUTE_SURFACE.some((route) => pattern.test(route.template)),
      `${family} routes are missing from GATEWAY_ROUTE_SURFACE, so the envelope test covers nothing`,
    );
  }
});

test("terminal, AG Loop UI and GitHub routes all fail with the one shared envelope", async () => {
  await withFullySpecifiedRouter(async (router) => {
    for (const route of GATEWAY_ROUTE_SURFACE) {
      const operation = `${route.method} ${route.template}`;
      // A body that cannot parse, sent with no credentials. An authenticated
      // route must answer 401 rather than 400: reaching JSON parsing before
      // authentication would turn DTO validation into a request-shape oracle and
      // make the host parse untrusted input for an anonymous caller.
      const response = await router.handle({
        method: route.method,
        path: concreteTarget(route.template),
        headers: { "content-type": "application/json" },
        body: "}not json{",
        remoteAddress: "198.51.100.43",
      });

      assert.ok(response.status >= 400, `${operation} must reject an unauthenticated caller`);
      if (!UNAUTHENTICATED_ROUTES.has(operation)) {
        assert.equal(
          response.status,
          401,
          `${operation} must authenticate before it reads a body`,
        );
      }

      // Envelope shape, declared code, and — through the shared helper — the one
      // status and the one recoverable verdict the tables give that code.
      assertEnvelopeMatchesTables(response, operation);
      const error = response.body["error"] as Record<string, unknown>;
      assert.ok((error["message"] as string).length > 0, `${operation} must carry a message`);
      // Generic mapping: the envelope names the gateway's own failure mode, never
      // an upstream one. `gh`, git and PTY diagnostics stay on the host.
      assert.doesNotMatch(
        error["message"] as string,
        /gh |git |fatal:|ENOENT|node_modules|[A-Za-z]:\\|\/tmp\/|\/home\//,
        `${operation} leaked upstream detail into the envelope`,
      );

      assert.equal(response.headers["cache-control"], "no-store", operation);
      assert.equal(response.headers["x-content-type-options"], "nosniff", operation);
      assert.equal(response.headers["content-type"], "application/json; charset=utf-8", operation);
      assert.equal(response.stream, undefined, `${operation} must not stream a failure`);
    }
  });
});
