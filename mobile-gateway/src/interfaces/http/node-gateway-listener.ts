import type { Server as HttpsServer } from "node:https";
import type {
  GatewayListenerHandle,
  GatewayListenerPort,
} from "../../application/ports/gateway-listener-port.js";

/**
 * Node listener for an already-approved bind target.
 *
 * The server is injected as a type only: this adapter never constructs TLS
 * options and never decides where to listen. It executes one decision the bind
 * policy already made, and then verifies that the kernel agreed.
 */

function normalizeAddress(value: string): string {
  const zoneIndex = value.indexOf("%");
  return (zoneIndex === -1 ? value : value.slice(0, zoneIndex)).toLowerCase();
}

function closeQuietly(server: HttpsServer): Promise<void> {
  return new Promise((resolve) => {
    // A server that is already closed reports `ERR_SERVER_NOT_RUNNING`; the
    // caller asked for "not listening", and that is what it has.
    server.close(() => resolve());
  });
}

export function createNodeGatewayListener(server: HttpsServer): GatewayListenerPort {
  return {
    start(request) {
      return new Promise<GatewayListenerHandle>((resolve, reject) => {
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
          const bound = server.address();
          if (
            bound === null ||
            typeof bound === "string" ||
            normalizeAddress(bound.address) !== normalizeAddress(request.address) ||
            bound.port !== request.port
          ) {
            // Last line of defence between the policy decision and the real
            // socket: a listener on anything other than the approved target is
            // closed rather than handed back.
            void closeQuietly(server).then(() => {
              reject(new Error("Gateway listener bound an address the bind policy did not approve"));
            });
            return;
          }
          resolve(
            Object.freeze({
              address: bound.address,
              port: bound.port,
              close: () => closeQuietly(server),
            }),
          );
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          host: request.address,
          port: request.port,
          // Without `exclusive` a clustered process would silently share the
          // port with a sibling this bootstrap never validated.
          exclusive: true,
          // An IPv6 bind must not become a dual-stack listener that also
          // accepts IPv4 traffic through an address the policy never saw.
          ipv6Only: request.family === "ipv6",
        });
      });
    },
  };
}
