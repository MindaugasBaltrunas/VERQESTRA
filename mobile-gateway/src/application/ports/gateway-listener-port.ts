export type GatewayListenRequest = Readonly<{
  address: string;
  port: number;
  family: "ipv4" | "ipv6";
}>;

export type GatewayListenerHandle = Readonly<{
  /** Address and port the socket actually bound, as reported by the transport. */
  address: string;
  port: number;
  close(): Promise<void>;
}>;

/**
 * Opening of the approved socket.
 *
 * Bootstrap owns the `listening` state but may not import the interfaces layer,
 * so the transport is inverted behind this port: the application decides
 * whether a listener may exist, and something in `interfaces/http` knows what
 * `node:https` is.
 */
export interface GatewayListenerPort {
  start(request: GatewayListenRequest): Promise<GatewayListenerHandle>;
}
