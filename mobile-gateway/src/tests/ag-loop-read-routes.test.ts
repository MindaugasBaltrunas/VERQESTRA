import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import type {
  AgLoopStreamMessage,
  AgLoopUiReadPort,
} from "../application/ports/ag-loop-ui-read-port.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectReadService } from "../application/project-read-service.js";
import { ProjectRegistry } from "../application/project-registry.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import {
  GATEWAY_ROUTE_SURFACE,
  RemoteGatewayRouter,
  type GatewayHttpResponse,
} from "../interfaces/http/remote-gateway-router.js";
import { agLoopUiReadDouble } from "./ag-loop-ui-read-double.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";
import { pairTestDevice } from "./paired-device.js";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const HIDDEN_PROJECT_ID = "123e4567-e89b-42d3-a456-426614174001";
const NOW = new Date("2026-08-06T10:00:00.000Z");

/** Every AG Loop UI read the gateway serves, as a concrete request target. */
const AG_READ_TARGETS: readonly string[] = Object.freeze([
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/dashboard`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/tasks?bucket=queue`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/logs?log=claude`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/events`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/policy-controls`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/learning`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/token-usage`,
  `/v1/projects/${PROJECT_ID}/ag-loop/ui/token-analytics`,
]);

type Harness = Readonly<{
  router: RemoteGatewayRouter;
  authorization: string;
  terminalAuthorization: string;
  directory: string;
}>;

async function harness(agLoopUi: AgLoopUiReadPort | undefined): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-read-routes-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "repository", ".git"), { recursive: true });
  const registry = await ProjectRegistry.create({ personal: workspace });
  for (const projectId of [PROJECT_ID, HIDDEN_PROJECT_ID]) {
    await registry.registerExisting({
      projectId,
      name: `Project ${projectId.slice(-4)}`,
      rootId: "personal",
      relativePath: "repository",
      branch: "main",
    });
  }
  const auth = new DeviceAuthService(
    new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
  );
  const reader = await pairTestDevice(auth, NOW, ["ag:read"], "Reader phone");
  const terminalOnly = await pairTestDevice(auth, NOW, ["terminal:write"], "Terminal phone");
  const membership: ProjectMembershipPort = {
    async canReadProject(principalId, projectId) {
      return principalId === reader.principalId && projectId === PROJECT_ID;
    },
    async canControlTerminal() {
      return false;
    },
  };
  return {
    directory,
    authorization: `Bearer ${reader.accessToken}`,
    terminalAuthorization: `Bearer ${terminalOnly.accessToken}`,
    router: new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => NOW,
      projectReads: new ProjectReadService(
        registry,
        membership,
        (projectId) => projectId === PROJECT_ID ? agLoopUi : undefined,
      ),
      audit: new InMemoryAuditLog(),
    }),
  };
}

async function frames(response: GatewayHttpResponse, count: number): Promise<string[]> {
  assert.ok(response.stream, "the events route must answer with a stream");
  const taken: string[] = [];
  for await (const frame of response.stream) {
    taken.push(frame);
    if (taken.length === count) break;
  }
  return taken;
}

test("every AG Loop UI read demands the ag:read scope", async () => {
  const { router, terminalAuthorization, directory } = await harness(agLoopUiReadDouble());
  try {
    for (const path of AG_READ_TARGETS) {
      assert.equal((await router.handle({ method: "GET", path })).status, 401, path);
      assert.equal((await router.handle({
        method: "GET",
        path,
        headers: { authorization: terminalAuthorization },
      })).status, 403, path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every AG Loop UI read is invisible for a project the principal cannot see", async () => {
  const { router, authorization, directory } = await harness(agLoopUiReadDouble());
  try {
    for (const path of AG_READ_TARGETS) {
      const hidden = path.replace(PROJECT_ID, HIDDEN_PROJECT_ID);
      assert.equal((await router.handle({
        method: "GET",
        path: hidden,
        headers: { authorization },
      })).status, 404, hidden);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no AG Loop UI path answers a mutation verb", async () => {
  const { router, authorization, directory } = await harness(agLoopUiReadDouble());
  try {
    for (const path of AG_READ_TARGETS) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await router.handle({
          method,
          path,
          headers: { authorization, "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the declared route surface covers every AG Loop UI read this test exercises", () => {
  const declared = GATEWAY_ROUTE_SURFACE
    .filter((route) => route.template.includes("/ag-loop/ui/"))
    .map((route) => route.template.replace("{projectId}", PROJECT_ID));
  assert.deepEqual(
    [...declared].sort(),
    [...AG_READ_TARGETS].map((target) => target.split("?")[0]).sort(),
  );
});

test("read bounds and query allowlists are enforced before the upstream is touched", async () => {
  const unreachable = agLoopUiReadDouble({
    async logs() {
      throw new Error("an invalid request must not reach the AG Loop UI");
    },
    async tokenUsage() {
      throw new Error("an invalid request must not reach the AG Loop UI");
    },
  });
  const { router, authorization, directory } = await harness(unreachable);
  try {
    for (const query of [
      "logs?log=secrets",
      "logs",
      "logs?log=claude&lines=0",
      "logs?log=claude&lines=201",
      "logs?log=claude&lines=ten",
      "logs?log=claude&log=orchestrator",
      "logs?log=claude&follow=1",
      "token-usage?limit=501",
      "token-usage?limit=-1",
      "token-analytics?limit=10",
      "learning?since=2026-01-01",
      "policy-controls?group=dispatch",
      "events?replay=1",
      "dashboard?verbose=1",
      "tasks?bucket=../etc",
    ]) {
      const response = await router.handle({
        method: "GET",
        path: `/v1/projects/${PROJECT_ID}/ag-loop/ui/${query}`,
        headers: { authorization },
      });
      assert.equal(response.status, 400, query);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("in-range read bounds reach the read service unchanged", async () => {
  const seen: Array<Readonly<{ log?: string; lines?: number; limit?: number }>> = [];
  const { router, authorization, directory } = await harness(agLoopUiReadDouble({
    async logs(log, lines) {
      seen.push({ log, lines });
      return { log, lines: [], truncated: false };
    },
    async tokenUsage(limit) {
      seen.push({ limit });
      return { records: [] };
    },
  }));
  try {
    for (const query of ["logs?log=orchestrator&lines=25", "logs?log=checks", "token-usage"]) {
      assert.equal((await router.handle({
        method: "GET",
        path: `/v1/projects/${PROJECT_ID}/ag-loop/ui/${query}`,
        headers: { authorization },
      })).status, 200, query);
    }
    assert.deepEqual(seen, [
      { log: "orchestrator", lines: 25 },
      { log: "checks", lines: 100 },
      { limit: 100 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreachable AG Loop UI is reported as offline without upstream detail", async () => {
  const { router, authorization, directory } = await harness(agLoopUiReadDouble({
    async logs() {
      throw new Error(`upstream-secret token=${"ghp_" + "0123456789abcdefghij"} at ${tmpdir()}`);
    },
    async tokenUsage() {
      throw new Error("upstream-secret");
    },
    async tokenAnalytics() {
      throw new Error("upstream-secret");
    },
    async policyControls() {
      throw new Error("upstream-secret");
    },
    async learning() {
      throw new Error("upstream-secret");
    },
  }));
  try {
    for (const query of [
      "logs?log=claude",
      "token-usage",
      "token-analytics",
      "policy-controls",
      "learning",
    ]) {
      const response = await router.handle({
        method: "GET",
        path: `/v1/projects/${PROJECT_ID}/ag-loop/ui/${query}`,
        headers: { authorization },
      });
      assert.equal(response.status, 503, query);
      assert.equal(assertEnvelopeMatchesTables(response, query), "ag_loop_ui_offline", query);
      assert.equal(JSON.stringify(response.body).includes("upstream-secret"), false, query);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unconfigured AG Loop UI is offline rather than a missing route", async () => {
  const { router, authorization, directory } = await harness(undefined);
  try {
    for (const path of AG_READ_TARGETS) {
      const response = await router.handle({ method: "GET", path, headers: { authorization } });
      assert.equal(response.status, 503, path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the events route streams sanitized SSE frames with reconnect guidance", async () => {
  const { router, authorization, directory } = await harness(agLoopUiReadDouble({
    activityStream(): AsyncIterable<AgLoopStreamMessage> {
      return (async function* stream() {
        yield { type: "keepalive" } as const;
        yield {
          type: "activity",
          activity: {
            chain: ["coder"],
            statuses: { coder: "running" },
            currentAgent: "coder",
            currentActivity: "Bash([REDACTED])",
            taskId: "1135-read-only-proxy",
            claudeStatus: "running",
            mode: "inline",
            updatedAt: NOW.toISOString(),
          },
        } as const;
      })();
    },
  }));
  try {
    const response = await router.handle({
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/ag-loop/ui/events`,
      headers: { authorization },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.body, {});
    const written = await frames(response, 3);
    assert.equal(written[0], "retry: 3000\n\n");
    assert.equal(written[1], ": keepalive\n\n");
    assert.match(written[2] ?? "", /^id: 1\nevent: activity\ndata: \{.*\}\n\n$/s);
    assert.match(written[2] ?? "", /"taskId":"1135-read-only-proxy"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing upstream ends the stream with an offline frame instead of a stack trace", async () => {
  const { router, authorization, directory } = await harness(agLoopUiReadDouble({
    activityStream(): AsyncIterable<AgLoopStreamMessage> {
      return (async function* stream(): AsyncGenerator<AgLoopStreamMessage> {
        throw new Error(`upstream-secret at ${tmpdir()}`);
      })();
    },
  }));
  try {
    const response = await router.handle({
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/ag-loop/ui/events`,
      headers: { authorization },
    });
    const written = await frames(response, 2);
    assert.equal(written[1], `event: end\ndata: {"reason":"ag_loop_ui_offline"}\n\n`);
    assert.equal(written.join("").includes("upstream-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one device cannot hold more activity streams than the gateway allows", async () => {
  const { router, authorization, directory } = await harness(agLoopUiReadDouble({
    activityStream(signal): AsyncIterable<AgLoopStreamMessage> {
      return (async function* stream(): AsyncGenerator<AgLoopStreamMessage> {
        while (!signal.aborted) {
          yield { type: "keepalive" };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
    },
  }));
  const open: AsyncIterator<string>[] = [];
  try {
    const path = `/v1/projects/${PROJECT_ID}/ag-loop/ui/events`;
    for (let index = 0; index < 2; index += 1) {
      const response = await router.handle({ method: "GET", path, headers: { authorization } });
      assert.equal(response.status, 200);
      const iterator = response.stream![Symbol.asyncIterator]();
      // The slot is taken when the transport starts reading, so the stream has
      // to be started for the bound to mean anything.
      await iterator.next();
      open.push(iterator);
    }
    const refused = await router.handle({ method: "GET", path, headers: { authorization } });
    assert.equal(refused.status, 429);
    assert.equal(assertEnvelopeMatchesTables(refused, "activity stream budget"), "rate_limited");
    assert.equal(refused.headers["retry-after"], "5");

    // Releasing one stream frees exactly one slot.
    await open.pop()?.return?.();
    const accepted = await router.handle({ method: "GET", path, headers: { authorization } });
    assert.equal(accepted.status, 200);
    await accepted.stream![Symbol.asyncIterator]().return?.();
  } finally {
    for (const iterator of open) {
      await iterator.return?.();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
