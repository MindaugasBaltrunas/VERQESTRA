import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  LocalControlEndpoint,
  LocalControlHandler,
  LocalControlListenerHandle,
  LocalControlListenerPort,
  LocalControlRequest,
  LocalControlResponse,
} from "../../application/ports/local-control-listener-port.js";
import type {
  LocalPeerAttestation,
  LocalPeerIdentityPort,
} from "../../application/ports/local-peer-identity-port.js";
import { MAX_LOCAL_BODY_BYTES } from "./local-control-router.js";

/**
 * Node transport for the local control channel.
 *
 * A named pipe, a Unix-domain socket and a loopback port are one listener here
 * because Node serves HTTP over all three: `server.listen({ path })` binds a
 * pipe on Windows and a socket file elsewhere, so the request framing is the
 * standard parser rather than something hand-written per platform.
 *
 * The transport's own job is small and fixed: attest the peer, bound the body,
 * hand the request to the router and write what comes back. It makes no
 * authorisation decision — an attestation that could not be produced is passed
 * on as `unverified`, which the policy layer refuses, instead of being thrown
 * away as an error the router would never see.
 */

function responseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

function unverified(endpoint: LocalControlEndpoint, observedAt: string): LocalPeerAttestation {
  return Object.freeze({
    transport: endpoint.kind,
    assurance: "unverified" as const,
    endpointOwnerVerified: false,
    secretFileGuarded: false,
    observedAt,
  });
}

function writeResponse(response: ServerResponse, result: LocalControlResponse): void {
  const payload = JSON.stringify(result.body);
  response.writeHead(result.status, {
    ...result.headers,
    "content-length": String(Buffer.byteLength(payload, "utf8")),
  });
  response.end(payload);
}

function writeFailure(response: ServerResponse, status: number, code: string, message: string): void {
  writeResponse(response, {
    status,
    headers: responseHeaders(),
    body: { error: { code, message, correlationId: "", recoverable: status < 500 } },
  });
}

/**
 * Flattens the parser's header map. A repeated header is joined rather than
 * silently reduced to one value, so a request that sent two `Host` lines cannot
 * pass a check that only looked at the first.
 */
function singleValueHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/** Collects the request body, refusing anything over the transport bound. */
function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      // The same bound the router enforces, imported rather than restated: two
      // copies that drift would let the transport accept a body the router then
      // refuses, or the reverse.
      if (total > MAX_LOCAL_BODY_BYTES) {
        // Stop reading immediately: the point of the bound is not to buffer the
        // rest of an oversized body before refusing it. Pausing rather than
        // destroying is what lets the refusal still be written — a destroyed
        // socket turns the 400 below into a hang-up the caller cannot tell apart
        // from a gateway that died mid-request.
        request.pause();
        reject(new RangeError("Local control request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => resolve(total === 0 ? undefined : new Uint8Array(Buffer.concat(chunks))));
  });
}

export function createNodeLocalControlListener(
  peers: LocalPeerIdentityPort,
): LocalControlListenerPort {
  return {
    start(endpoint: LocalControlEndpoint, handler: LocalControlHandler) {
      const server = createServer((incoming, response) => {
        void (async () => {
          try {
            const body = await readBody(incoming);
            const observedAt = new Date().toISOString();
            let peer: LocalPeerAttestation;
            try {
              peer = await peers.attest(endpoint, {
                ...(incoming.socket.remoteAddress ? { peerAddress: incoming.socket.remoteAddress } : {}),
              });
            } catch {
              peer = unverified(endpoint, observedAt);
            }
            const request: LocalControlRequest = {
              method: incoming.method ?? "",
              path: incoming.url ?? "",
              headers: singleValueHeaders(incoming),
              ...(body ? { body } : {}),
              peer,
            };
            writeResponse(response, await handler(request));
          } catch (error) {
            if (error instanceof RangeError) {
              // The remainder of the oversized body is never read, so this
              // connection cannot be reused for a second request: it carries the
              // refusal and is then closed.
              response.setHeader("connection", "close");
              writeFailure(response, 400, "invalid_request", error.message);
              return;
            }
            writeFailure(response, 500, "internal_error", "Internal gateway error");
          }
        })();
      });
      return new Promise<LocalControlListenerHandle>((resolve, reject) => {
        let settled = false;
        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          if (settled) return;
          settled = true;
          server.removeListener("error", onError);
          resolve(Object.freeze({
            endpoint,
            close: () => new Promise<void>((closed) => {
              // Node unlinks a socket file it created; a server that is already
              // closed still satisfies "not listening".
              server.close(() => closed());
            }),
          }));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (endpoint.kind === "loopback-http") {
          server.listen({
            host: endpoint.address,
            port: endpoint.port,
            // Never share the port with a sibling process this listener did not
            // establish the ownership of.
            exclusive: true,
          });
        } else {
          server.listen({ path: endpoint.path, exclusive: true });
        }
      });
    },
  };
}
