import { randomUUID } from "node:crypto";
import {
  createServer,
  type Server as HttpsServer,
  type ServerOptions,
} from "node:https";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import {
  GATEWAY_RECOVERABLE_BY_CODE,
  GATEWAY_STATUS_BY_CODE,
  MAX_HTTP_BODY_BYTES,
  type GatewayHttpResponse,
} from "./remote-gateway-contract.js";
import type { RemoteGatewayRouter } from "./remote-gateway-router.js";

/**
 * NUKRYPIMAS (formos, ne elgesio): etalone visa ši šešiukė buvo importuojama iš
 * `remote-gateway-router.js`. VERQESTRA'oje žodynas gyvena `remote-gateway-contract.ts`, tad
 * transportas jį ima tiesiai iš ten ir nebeužsitraukia viso maršrutizatoriaus. Iš
 * maršrutizatoriaus lieka tik tipas — jis ir taip yra `type`-only.
 */

export const GATEWAY_TLS_LIMITS = Object.freeze({
  maxHeadersCount: 64,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
});

export type TlsServerFactory = (
  options: ServerOptions,
  listener: RequestListener,
) => HttpsServer;

function selectedHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const idempotencyKey = request.headers["idempotency-key"];
  return {
    "authorization": request.headers.authorization,
    "content-type": request.headers["content-type"],
    "idempotency-key": Array.isArray(idempotencyKey) ? undefined : idempotencyKey,
  };
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > MAX_HTTP_BODY_BYTES) {
      return Buffer.alloc(MAX_HTTP_BODY_BYTES + 1);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * How long one streamed frame may wait for a socket that is not draining.
 *
 * `requestTimeout` only bounds reading a request; nothing bounds writing a
 * response. Without this, a client that stops reading without closing the
 * connection (a half-open socket, a zero-window peer) parks the write forever,
 * and with it the upstream read and the per-device stream slot behind it.
 */
const STREAM_WRITE_TIMEOUT_MS = 30_000;

/** Resolves once the socket can accept more data, or once it is gone for good. */
function drained(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    function settle(): void {
      clearTimeout(timer);
      response.off("drain", settle);
      response.off("close", settle);
      response.off("error", settle);
      resolve();
    }
    const timer = setTimeout(() => {
      // The peer is not reading and not leaving. Take the socket away so the
      // stream can unwind instead of holding host resources indefinitely.
      response.destroy();
      settle();
    }, STREAM_WRITE_TIMEOUT_MS);
    timer.unref?.();
    response.once("drain", settle);
    response.once("close", settle);
    response.once("error", settle);
  });
}

/**
 * Writes a streaming response frame by frame.
 *
 * Backpressure is honoured rather than buffered away: a phone on a slow link
 * must not be able to grow the host's heap by simply not reading. The router is
 * told the moment the client is gone, so it can release the upstream connection
 * instead of discovering the loss at the next frame.
 */
async function writeStream(response: ServerResponse, result: GatewayHttpResponse): Promise<void> {
  const stream = result.stream;
  if (!stream) {
    return;
  }
  // A destroyed socket emits `error` on the response; without a listener that
  // would reach `uncaughtException` and take the whole gateway down.
  response.on("error", () => undefined);
  response.on("close", () => result.onClose?.());
  response.writeHead(result.status, result.headers);
  response.flushHeaders();
  try {
    for await (const frame of stream) {
      if (response.writableEnded || response.destroyed) {
        break;
      }
      if (!response.write(frame)) {
        await drained(response);
      }
    }
  } finally {
    if (!response.writableEnded) {
      response.end();
    }
    // Also signalled here, not only from `close`: a socket that was already gone
    // when the listener was attached emits nothing, and the router would keep a
    // reserved stream slot for a client that no longer exists. Both the abort
    // and the release behind this hook are idempotent.
    result.onClose?.();
  }
}

function writeResponse(response: ServerResponse, result: GatewayHttpResponse): void {
  response.writeHead(result.status, result.headers);
  if (result.status === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(result.body));
}

export function createGatewayRequestListener(router: RemoteGatewayRouter): RequestListener {
  return (request, response) => {
    void (async () => {
      const body = await readBoundedBody(request);
      const result = await router.handle({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: selectedHeaders(request),
        body,
        // Taken from the socket, never from a forwarded header: the rate-limit
        // key must not be something the remote caller can rotate at will.
        ...(request.socket.remoteAddress === undefined
          ? {}
          : { remoteAddress: request.socket.remoteAddress }),
      });
      if (result.stream) {
        await writeStream(response, result);
        return;
      }
      writeResponse(response, result);
    })().catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      // The last-resort envelope is built here rather than by the router, so it
      // reads the same two tables the router does: one status and one
      // recoverable verdict per code is a property of the gateway, not of the
      // layer that happened to answer.
      writeResponse(response, {
        status: GATEWAY_STATUS_BY_CODE.internal_error,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
        body: {
          error: {
            code: "internal_error",
            message: "Internal gateway error",
            correlationId: randomUUID(),
            recoverable: GATEWAY_RECOVERABLE_BY_CODE.internal_error,
          },
        },
      });
    });
  };
}

export function createGatewayTlsServer(input: {
  certificate: string | Buffer;
  privateKey: string | Buffer;
  router: RemoteGatewayRouter;
  factory?: TlsServerFactory;
}): HttpsServer {
  if (
    (typeof input.certificate === "string" && input.certificate.trim().length === 0) ||
    (Buffer.isBuffer(input.certificate) && input.certificate.byteLength === 0) ||
    (typeof input.privateKey === "string" && input.privateKey.trim().length === 0) ||
    (Buffer.isBuffer(input.privateKey) && input.privateKey.byteLength === 0)
  ) {
    throw new Error("TLS certificate and private key are required");
  }
  const factory = input.factory ?? createServer;
  const server = factory({
    cert: input.certificate,
    key: input.privateKey,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    requestCert: false,
  }, createGatewayRequestListener(input.router));
  server.maxHeadersCount = GATEWAY_TLS_LIMITS.maxHeadersCount;
  server.headersTimeout = GATEWAY_TLS_LIMITS.headersTimeoutMs;
  server.requestTimeout = GATEWAY_TLS_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = GATEWAY_TLS_LIMITS.keepAliveTimeoutMs;
  return server;
}
