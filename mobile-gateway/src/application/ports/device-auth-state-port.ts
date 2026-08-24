import type { DeviceAuthState } from "../../domain/device-auth.js";

export type AuthStateUpdate<T> = Readonly<{
  state: DeviceAuthState;
  result: T;
}>;

export interface DeviceAuthStatePort {
  read(): Promise<DeviceAuthState>;
  update<T>(
    mutate: (current: DeviceAuthState) => AuthStateUpdate<T>,
  ): Promise<T>;
}
