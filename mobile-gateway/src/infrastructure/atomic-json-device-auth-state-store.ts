import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AuthStateUpdate,
  DeviceAuthStatePort,
} from "../application/ports/device-auth-state-port.js";
import type { DeviceAuthState } from "../domain/device-auth.js";
import {
  defaultDeviceAuthStateFile,
  hostDataEnvironment,
  requireHostPlatform,
  type HostDataEnvironment,
} from "./gateway-data-directory.js";

function initialState(issuer: string, audience: string): DeviceAuthState {
  return {
    version: 1,
    issuer,
    audience,
    accessSigningKey: randomBytes(32).toString("base64url"),
    challenges: {},
    devices: {},
    refreshTokens: {},
  };
}

function cloneState(state: DeviceAuthState): DeviceAuthState {
  return structuredClone(state);
}

export class AtomicJsonDeviceAuthStateStore implements DeviceAuthStatePort {
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private state: DeviceAuthState | undefined;
  readonly stateFile: string;

  constructor(
    stateFile: string,
    private readonly issuer = "ag-mobile-gateway",
    private readonly audience = "ag-mobile-app",
  ) {
    this.stateFile = resolve(stateFile);
  }

  /**
   * Device keys, refresh tokens and the access signing key live in the
   * host-private OS application-data directory, never in the project tree.
   *
   * Options object rather than positional arguments because every argument here
   * is optional; the sibling factories take their one required argument
   * positionally.
   */
  static inGatewayDataDirectory(
    options: Readonly<{
      issuer?: string;
      audience?: string;
      environment?: HostDataEnvironment;
    }> = {},
  ): AtomicJsonDeviceAuthStateStore {
    return new AtomicJsonDeviceAuthStateStore(
      defaultDeviceAuthStateFile(requireHostPlatform(options.environment ?? hostDataEnvironment())),
      options.issuer,
      options.audience,
    );
  }

  private async load(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // 0o700: the credential directory is created before the first write, and
    // the file mode below would otherwise be the only thing standing between
    // another local account and the signing key.
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as DeviceAuthState;
      if (parsed.version !== 1 || !parsed.accessSigningKey) {
        throw new Error("Unsupported device auth state");
      }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.state = initialState(this.issuer, this.audience);
      await this.persist(this.state);
    }
    this.initialized = true;
  }

  private async persist(state: DeviceAuthState): Promise<void> {
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.stateFile);
  }

  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = (): void => undefined;
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async read(): Promise<DeviceAuthState> {
    return this.exclusively(async () => {
      await this.load();
      return cloneState(this.state as DeviceAuthState);
    });
  }

  async update<T>(mutate: (current: DeviceAuthState) => AuthStateUpdate<T>): Promise<T> {
    return this.exclusively(async () => {
      await this.load();
      const updated = mutate(cloneState(this.state as DeviceAuthState));
      await this.persist(updated.state);
      this.state = updated.state;
      return updated.result;
    });
  }
}
