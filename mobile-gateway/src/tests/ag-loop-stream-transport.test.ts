import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
import { RemoteGatewayRouter } from "../interfaces/http/remote-gateway-router.js";
import { createGatewayRequestListener } from "../interfaces/http/tls-gateway-server.js";
import { agLoopUiReadDouble } from "./ag-loop-ui-read-double.js";
import { pairTestDevice } from "./paired-device.js";

/**
 * Transport-level proof for the read-only AG Loop UI stream.
 *
 * `ag-loop-read-routes.test.ts` stops at the router: it asserts what the frames
 * say. Nothing asserted what the transport does with them — whether the SSE
 * headers actually reach the socket before the stream ends, whether a frame is
 * written as it is produced instead of buffered to the end, and whether a phone
 * that vanishes mid-stream releases both the upstream connection and its
 * per-device stream slot. Those are properties of `writeStream`, so they are
 * exercised through `createGatewayRequestListener` on a loopback server: the
 * only faithful `ServerResponse` is a real one, and a hand-written double would
 * assert the double's `close` semantics rather than Node's.
 *
 * Loopback only — no upstream, no TLS, no external host is contacted: the AG
 * Loop UI itself is the test double, exactly as in the router tests.
 */

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-08-06T10:00:00.000Z");
const WIRE_TIMEOUT_MS = 20_000;

type Harness = Readonly<{
  eventsUrl: string;
  readHeaders: Record<string, string>;
  url: (path: string) => string;
  close: () => Promise<void>;
}>;

async function serve(agLoopUi: AgLoopUiReadPort): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-stream-transport-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "repository", ".git"), { recursive: true });
  const registry = await ProjectRegistry.create({ personal: workspace });
  await registry.registerExisting({
    projectId: PROJECT_ID,
    name: "Streamed project",
    rootId: "personal",
    relativePath: "repository",
    branch: "main",
  });
  const auth = new DeviceAuthService(
    new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
  );
  const reader = await pairTestDevice(auth, NOW, ["ag:read"], "Streaming phone");
  const membership: ProjectMembershipPort = {
    async canReadProject(principalId, projectId) {
      return principalId === reader.principalId && projectId === PROJECT_ID;
    },
    async canControlTerminal() {
      return false;
    },
  };
  const router = new RemoteGatewayRouter({
    deviceAuth: auth,
    now: () => NOW,
    projectReads: new ProjectReadService(
      registry,
      membership,
      (projectId) => projectId === PROJECT_ID ? agLoopUi : undefined,
    ),
    audit: new InMemoryAuditLog(),
  });
  const server: Server = createServer(createGatewayRequestListener(router));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "the test server must report a bound port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    eventsUrl: `${origin}/v1/projects/${PROJECT_ID}/ag-loop/ui/events`,
    readHeaders: { authorization: `Bearer ${reader.accessToken}` },
    url: (path) => `${origin}${path}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type FrameSource = Readonly<{
  /** Up to `count` complete SSE frames, terminators included. */
  next: (count: number) => Promise<string[]>;
  /** Everything still unread once the server ends the response. */
  rest: () => Promise<string>;
}>;

function frameSource(response: Response): FrameSource {
  const body = response.body;
  assert.ok(body, "a streaming read must answer with a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const pull = async (): Promise<boolean> => {
    const chunk = await reader.read();
    if (chunk.done || !chunk.value) {
      ended = true;
      return false;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    return true;
  };
  return {
    async next(count) {
      const frames: string[] = [];
      while (frames.length < count) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          frames.push(buffer.slice(0, boundary + 2));
          buffer = buffer.slice(boundary + 2);
          continue;
        }
        if (!(await pull())) break;
      }
      return frames;
    },
    async rest() {
      while (!ended) {
        await pull();
      }
      const remaining = buffer;
      buffer = "";
      return remaining;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, reason: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(reason);
}

const ACTIVITY: AgLoopStreamMessage = Object.freeze({
  type: "activity",
  activity: Object.freeze({
    chain: Object.freeze(["coder"]),
    statuses: Object.freeze({ coder: "running" }),
    currentAgent: "coder",
    currentActivity: "Bash([REDACTED])",
    taskId: "1135-read-only-proxy",
    claudeStatus: "running",
    mode: "inline",
    updatedAt: NOW.toISOString(),
  }),
});

test("the transport writes SSE headers and each frame before the stream ends", {
  timeout: WIRE_TIMEOUT_MS,
}, async () => {
  // The source stays silent until the test has already inspected the response,
  // so a transport that buffered the body would never let `fetch` resolve.
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = await serve(agLoopUiReadDouble({
    activityStream(): AsyncIterable<AgLoopStreamMessage> {
      return (async function* stream(): AsyncGenerator<AgLoopStreamMessage> {
        await gate;
        yield { type: "keepalive" };
        yield ACTIVITY;
      })();
    },
  }));
  try {
    const response = await fetch(harness.eventsUrl, { headers: harness.readHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    // Chunked with no length: the phone is being streamed to, not sent a document.
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("transfer-encoding"), "chunked");

    const frames = frameSource(response);
    assert.deepEqual(
      await frames.next(1),
      ["retry: 3000\n\n"],
      "reconnect guidance must reach the phone before any event exists",
    );

    release();
    const streamed = await frames.next(2);
    assert.equal(streamed[0], ": keepalive\n\n");
    assert.match(streamed[1] ?? "", /^id: 1\nevent: activity\ndata: \{.*\}\n\n$/s);
    // An exhausted source closes the response instead of holding the socket.
    assert.equal(await frames.rest(), "");
  } finally {
    await harness.close();
  }
});

test("a phone that disappears mid-stream frees its upstream read and its stream slot", {
  timeout: WIRE_TIMEOUT_MS,
}, async () => {
  const abandoned: number[] = [];
  let opened = 0;
  const harness = await serve(agLoopUiReadDouble({
    activityStream(signal): AsyncIterable<AgLoopStreamMessage> {
      const index = (opened += 1);
      return (async function* stream(): AsyncGenerator<AgLoopStreamMessage> {
        yield { type: "keepalive" };
        // Deliberately silent afterwards: a slot released only when the next
        // frame happens to arrive would be a leak on an idle AG Loop.
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        abandoned.push(index);
      })();
    },
  }));
  const controllers = [new AbortController(), new AbortController()];
  try {
    for (const controller of controllers) {
      const response = await fetch(harness.eventsUrl, {
        headers: harness.readHeaders,
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        await frameSource(response).next(2),
        ["retry: 3000\n\n", ": keepalive\n\n"],
        "the slot is only taken once the transport starts reading",
      );
    }

    const refused = await fetch(harness.eventsUrl, { headers: harness.readHeaders });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(refused.headers.get("retry-after"), "5");
    const refusedBody = await refused.json() as { error: { code: string } };
    assert.equal(refusedBody.error.code, "rate_limited");
    assert.equal(opened, 2, "a refused stream must not open an upstream read");

    for (const controller of controllers) {
      controller.abort();
    }
    await waitFor(
      () => abandoned.length === 2,
      "a dropped client must abort its upstream AG Loop UI read",
    );

    const accepted = await fetch(harness.eventsUrl, { headers: harness.readHeaders });
    assert.equal(accepted.status, 200, "both abandoned stream slots must be released");
    assert.deepEqual(await frameSource(accepted).next(1), ["retry: 3000\n\n"]);
  } finally {
    for (const controller of controllers) {
      controller.abort();
    }
    await harness.close();
  }
});

test("upstream text cannot forge SSE frames the phone would read as events", {
  timeout: WIRE_TIMEOUT_MS,
}, async () => {
  const injection = "\n\nevent: forged\ndata: {\"granted\":true}\n\nid: 99";
  const harness = await serve(agLoopUiReadDouble({
    activityStream(): AsyncIterable<AgLoopStreamMessage> {
      return (async function* stream(): AsyncGenerator<AgLoopStreamMessage> {
        yield {
          type: "activity",
          activity: {
            chain: [`coder${injection}`],
            statuses: { [`coder${injection}`]: `running${injection}` },
            currentAgent: `coder${injection}`,
            currentActivity: `Bash(npm test)${injection}`,
            taskId: `1135${injection}`,
            claudeStatus: `running${injection}`,
            mode: "inline",
            updatedAt: NOW.toISOString(),
          },
        };
      })();
    },
  }));
  try {
    const response = await fetch(harness.eventsUrl, { headers: harness.readHeaders });
    assert.equal(response.status, 200);
    const body = await response.text();

    // Exactly two frames on the wire: the reconnect hint and one activity event.
    const frames = body.split("\n\n").filter((frame) => frame.length > 0);
    assert.equal(frames.length, 2, `injected framing reached the phone: ${JSON.stringify(body)}`);
    assert.equal(frames[0], "retry: 3000");
    // SSE fields are decided by line starts, so that is what must stay ours: the
    // injected `event:`/`id:` text may exist only inside a data value.
    const lineStarts = (field: string): string[] =>
      body.split("\n").filter((line) => line.startsWith(field));
    assert.deepEqual(lineStarts("event:"), ["event: activity"]);
    assert.deepEqual(lineStarts("id:"), ["id: 1"]);
    assert.equal(lineStarts("data:").length, 1);

    // The hostile text still travels — escaped inside the JSON payload, where a
    // phone parses it as data instead of as a second event.
    const lines = (frames[1] ?? "").split("\n");
    assert.deepEqual(lines.slice(0, 2), ["id: 1", "event: activity"]);
    assert.equal(lines.length, 3, "an activity event must be a single data line");
    const payload = JSON.parse((lines[2] ?? "").slice("data: ".length)) as {
      currentActivity: string;
      taskId: string;
    };
    assert.ok(payload.currentActivity.includes("event: forged"));
    assert.ok(payload.taskId.includes("event: forged"));
  } finally {
    await harness.close();
  }
});

test("no AG Loop UI mutation survives the transport, and none reaches the upstream", {
  timeout: WIRE_TIMEOUT_MS,
}, async () => {
  const refuse = async (): Promise<never> => {
    throw new Error("a mutation must never reach the AG Loop UI");
  };
  const harness = await serve({
    dashboard: refuse,
    taskBucket: refuse,
    logs: refuse,
    tokenUsage: refuse,
    tokenAnalytics: refuse,
    policyControls: refuse,
    learning: refuse,
    activityStream(): AsyncIterable<AgLoopStreamMessage> {
      throw new Error("a mutation must never open the AG Loop UI stream");
    },
  });
  try {
    for (const resource of [
      "dashboard",
      "tasks",
      "logs",
      "events",
      "policy-controls",
      "learning",
      "token-usage",
      "token-analytics",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(
          harness.url(`/v1/projects/${PROJECT_ID}/ag-loop/ui/${resource}`),
          {
            method,
            headers: { ...harness.readHeaders, "content-type": "application/json" },
            // `exactOptionalPropertyTypes`: `body: undefined` čia reikštų „laukas yra ir
            // neapibrėžtas"; DELETE atveju lauko tiesiog NĖRA, ir spread'as tai pasako tiksliai.
            ...(method === "DELETE" ? {} : { body: JSON.stringify({ value: "on" }) }),
          },
        );
        assert.equal(response.status, 404, `${method} ${resource}`);
        assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
        const failure = await response.json() as { error: { code: string } };
        // The AG family is matched for GET only, so a mutation verb is not a
        // refused write — it is a route that does not exist, and the envelope
        // names it as one.
        assert.equal(failure.error.code, "not_found", `${method} ${resource}`);
      }
    }
  } finally {
    await harness.close();
  }
});
