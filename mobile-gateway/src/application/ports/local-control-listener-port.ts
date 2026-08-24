import type {
  LocalControlEndpoint,
  LocalPeerAttestation,
} from "./local-peer-identity-port.js";

/**
 * The transport the local control surface is served on.
 *
 * It is deliberately NOT the remote gateway listener: `local-control-contract.md`
 * excludes this surface from the phone-facing server, and sharing a listener
 * would make that exclusion a routing decision instead of a binding one. A pipe,
 * a Unix-domain socket and a separately bound loopback port are the three shapes
 * the contract allows, and every one of them carries the peer attestation with
 * the request — a handler must never have to ask the transport a second question
 * about who is calling.
 */

export type { LocalControlEndpoint };

export type LocalControlRequest = Readonly<{
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: Uint8Array;
  /** Established by the transport before the request was accepted. */
  peer: LocalPeerAttestation;
}>;

export type LocalControlResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
}>;

export type LocalControlHandler = (request: LocalControlRequest) => Promise<LocalControlResponse>;

export type LocalControlListenerHandle = Readonly<{
  endpoint: LocalControlEndpoint;
  close(): Promise<void>;
}>;

export interface LocalControlListenerPort {
  start(endpoint: LocalControlEndpoint, handler: LocalControlHandler): Promise<LocalControlListenerHandle>;
}
