import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import test from "node:test";
import type {
  GatewayHttpRequest,
  GatewayHttpResponse,
  RemoteGatewayRouter,
} from "../interfaces/http/remote-gateway-router.js";
import { createGatewayRequestListener } from "../interfaces/http/tls-gateway-server.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";

/**
 * The transport's last-resort answer.
 *
 * `createGatewayRequestListener` ends in a `catch` that exists for the fault the
 * router itself could not turn into an envelope. Nothing exercised it: every
 * router test drives a real `RemoteGatewayRouter`, and that router maps every
 * failure it can reach into a response — which is precisely why this branch
 * needs a double. Without it the case is unreachable, and an unreachable
 * `catch` is where an unhandled rejection, a hung socket or a naked stack trace
 * on the wire would live undetected.
 *
 * The double implements the one method the listener calls. It is cast rather
 * than subclassed because the listener depends on `handle` alone, and a
 * half-constructed real router would be asserting the constructor's behaviour.
 *
 * Loopback HTTP, no TLS: the property under test is what the listener writes,
 * and only a real `ServerResponse` reports `headersSent` the way Node does.
 */

type Handle = (request: GatewayHttpRequest) => Promise<GatewayHttpResponse>;

type Harness = Readonly<{
  url: (path: string) => string;
  close: () => Promise<void>;
}>;

async function serve(handle: Handle): Promise<Harness> {
  const listener: RequestListener = createGatewayRequestListener(
    { handle } as unknown as RemoteGatewayRouter,
  );
  const server: Server = createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "the test server must report a bound port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: (path) => `${origin}${path}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

test("a router that throws is answered with the gateway's own error envelope", async () => {
  const harness = await serve(async () => {
    // Not a `LocalControlError`, not a `TerminalSupervisorError`: the branch
    // exists for the failure no layer classified, so the double throws the least
    // structured thing a host can produce.
    throw new Error("the router blew up before it could answer");
  });
  try {
    const first = await fetch(harness.url("/v1/projects"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anything: true }),
    });
    const body = await first.json() as Readonly<Record<string, unknown>>;

    // Read out of the shared tables, never restated here: the point of building
    // the envelope in the transport is that one status and one recoverable
    // verdict per code is a property of the gateway, not of whichever layer
    // happened to answer.
    assert.equal(
      assertEnvelopeMatchesTables({ status: first.status, body }, "a router that threw"),
      "internal_error",
    );
    assert.equal(first.status, 500);

    // A fault must not become a cacheable answer, a sniffable one, or a stack
    // trace: the caller learns that the gateway failed and nothing about how.
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    const error = body["error"] as Record<string, unknown>;
    assert.equal(error["message"], "Internal gateway error");
    assert.doesNotMatch(JSON.stringify(body), /blew up|Error:|\bat\s+\w+\s+\(/);

    // Each failure is its own incident, so two of them are separately traceable.
    const second = await fetch(harness.url("/v1/projects"), { method: "POST" });
    const secondBody = await second.json() as Readonly<Record<string, unknown>>;
    assert.equal(
      assertEnvelopeMatchesTables({ status: second.status, body: secondBody }, "a second fault"),
      "internal_error",
    );
    assert.notEqual(
      (secondBody["error"] as Record<string, unknown>)["correlationId"],
      error["correlationId"],
    );
  } finally {
    await harness.close();
  }
});

test("a stream that fails mid-flight ends the response instead of writing a second answer", async () => {
  const frame = "data: {\"seq\":1}\n\n";
  const harness = await serve(async () => ({
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
      "x-content-type-options": "nosniff",
    },
    body: {},
    stream: (async function* frames(): AsyncGenerator<string> {
      yield frame;
      throw new Error("the upstream read collapsed after the first frame");
    })(),
  }));
  try {
    const response = await fetch(harness.url("/v1/projects/p/ag-loop/ui/events"));
    // The status line and the headers are already on the wire, so the last-resort
    // envelope cannot be written: a second `writeHead` would throw inside the
    // catch — taking the gateway down — and a JSON body appended to an SSE
    // stream would be read by the phone as a frame the contract never declared.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), frame);
  } finally {
    await harness.close();
  }
});
