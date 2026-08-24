import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server as HttpsServer } from "node:https";
import test from "node:test";
import { createNodeGatewayListener } from "../interfaces/http/node-gateway-listener.js";
import { BIND_ADDRESS, BIND_PORT } from "./host-bootstrap-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): iškelta iš `host-bootstrap.test.ts` (etalone 618 eil.).
 *
 * Pjūvis prasmingas: `HostBootstrap` sprendžia, AR lizdas gali egzistuoti, o šis adapteris —
 * ar Node tikrai atidarė BŪTENT tą taikinį, kurį politika patvirtino. Jo fikstūra yra kita:
 * ne sertifikatai ir sąsajos, o `node:https`.Server pakaitalas.
 */

/** Minimal stand-in for `node:https`.Server: enough surface for the adapter. */
class FakeHttpsServer extends EventEmitter {
  readonly listenCalls: unknown[] = [];
  closeCalls = 0;
  #bound: { address: string; family: string; port: number } | null;

  constructor(bound: { address: string; family: string; port: number } | null) {
    super();
    this.#bound = bound;
  }

  listen(options: unknown): this {
    this.listenCalls.push(options);
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    return this.#bound;
  }

  close(callback?: () => void): this {
    this.closeCalls += 1;
    callback?.();
    return this;
  }
}

test("the node listener binds exactly the approved target", async () => {
  const server = new FakeHttpsServer({ address: "fd12::1", family: "IPv6", port: BIND_PORT });
  const listener = createNodeGatewayListener(server as unknown as HttpsServer);

  const handle = await listener.start({ address: "fd12::1", port: BIND_PORT, family: "ipv6" });
  assert.deepEqual(server.listenCalls, [
    { host: "fd12::1", port: BIND_PORT, exclusive: true, ipv6Only: true },
  ]);
  assert.equal(handle.address, "fd12::1");
  assert.equal(handle.port, BIND_PORT);
  assert.equal(server.closeCalls, 0);

  await handle.close();
  assert.equal(server.closeCalls, 1);
});

test("an IPv4 bind is not requested as IPv6-only", async () => {
  const server = new FakeHttpsServer({ address: BIND_ADDRESS, family: "IPv4", port: BIND_PORT });
  const listener = createNodeGatewayListener(server as unknown as HttpsServer);
  await listener.start({ address: BIND_ADDRESS, port: BIND_PORT, family: "ipv4" });
  assert.deepEqual(server.listenCalls, [
    { host: BIND_ADDRESS, port: BIND_PORT, exclusive: true, ipv6Only: false },
  ]);
});

test("a socket bound somewhere other than the approved target is closed, not returned", async () => {
  const server = new FakeHttpsServer({ address: BIND_ADDRESS, family: "IPv4", port: 1 });
  const listener = createNodeGatewayListener(server as unknown as HttpsServer);

  await assert.rejects(
    listener.start({ address: BIND_ADDRESS, port: BIND_PORT, family: "ipv4" }),
    /bind policy did not approve/,
  );
  assert.equal(server.closeCalls, 1);
});
