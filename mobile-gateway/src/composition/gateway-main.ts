import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DeviceAuthService } from "../application/device-auth-service.js";
import { HostBootstrap, HostBootstrapError, type ResolvedHostBinding } from "../application/host-bootstrap.js";
import { IsolatedWorktreeService } from "../application/isolated-worktree-service.js";
import { LocalControlService } from "../application/local-control-service.js";
import { LocalIntegrationService } from "../application/local-integration-service.js";
import { resolveLocalControlEndpoint } from "../application/local-peer-policy.js";
import type { GatewayListenerPort } from "../application/ports/gateway-listener-port.js";
import type {
  LocalControlEndpoint,
  LocalControlListenerHandle,
} from "../application/ports/local-control-listener-port.js";
import { SoloOwnerProjectMembership } from "../application/ports/project-membership-port.js";
import { ProjectReadService } from "../application/project-read-service.js";
import { ProjectRegistry } from "../application/project-registry.js";
import { SessionGateService } from "../application/session-gate-service.js";
import { TerminalStreamService } from "../application/terminal-stream-service.js";
import { TerminalSupervisor } from "../application/terminal-supervisor.js";
import { AgLoopUiHttpAdapter } from "../infrastructure/ag-loop-ui-http-adapter.js";
import { AppendOnlyAuditFileStore } from "../infrastructure/append-only-audit-file-store.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { AtomicJsonSessionRegistryStore } from "../infrastructure/atomic-json-session-registry-store.js";
import { FileHostCertificateSource } from "../infrastructure/file-host-certificate-source.js";
import {
  createFileSessionGateEvidenceRecorder,
  createFileSessionGateEvidenceStore,
} from "../infrastructure/file-session-gate-evidence-store.js";
import {
  defaultAuditLogFile,
  defaultDeviceAuthStateFile,
  defaultGateEvidenceDirectory,
  defaultLocalControlSecretFile,
  defaultLocalControlSocketDirectory,
  defaultSessionRegistryFile,
  hostDataEnvironment,
  requireHostPlatform,
  resolveGatewayDataDirectory,
  type HostDataEnvironment,
} from "../infrastructure/gateway-data-directory.js";
import { createLocalControlSecretFile } from "../infrastructure/local-control-secret-file.js";
import { NodeGateCommandRunner } from "../infrastructure/node-gate-command-runner.js";
import { NodeGitRunner } from "../infrastructure/node-git-runner.js";
import { NodePtyDirectAgentTerminalAdapter } from "../infrastructure/node-pty-direct-agent-terminal-adapter.js";
import { OsHostNetworkInterfaces } from "../infrastructure/os-host-network-interfaces.js";
import { createOsLocalPeerIdentity } from "../infrastructure/os-local-peer-identity.js";
import { LocalControlRouter } from "../interfaces/http/local-control-router.js";
import { createNodeGatewayListener } from "../interfaces/http/node-gateway-listener.js";
import { createNodeLocalControlListener } from "../interfaces/http/node-local-control-listener.js";
import { RemoteGatewayRouter } from "../interfaces/http/remote-gateway-router.js";
import { createGatewayTlsServer, type TlsServerFactory } from "../interfaces/http/tls-gateway-server.js";
import { attachTerminalWebSocketGateway } from "../interfaces/websocket/terminal-websocket-gateway.js";
import {
  GATEWAY_CONFIGURATION_FILE_NAME,
  GatewayNotConfiguredError,
  detailOf,
  readGatewayConfiguration,
  type GatewayConfiguration,
} from "./gateway-configuration.js";

/**
 * The gateway's composition root: the one place that turns the package's parts
 * into a process.
 *
 * Everything below is wiring. No rule is decided here — the bind policy, the
 * certificate contract, the peer attestation and the gate catalogue each refuse
 * on their own terms, and this file's only job is to hand them their
 * collaborators and to let their refusals reach the operator intact. That is why
 * every failure path ends in one shape: `not_configured` with the reason the
 * layer below gave, never a stack trace and never a weaker listener.
 *
 * There is no plain-HTTP fallback anywhere in here, by construction: the only
 * phone-facing socket this file can open is the one `createGatewayTlsServer`
 * built from operator-supplied certificate material, and it is opened through
 * {@link HostBootstrap}, which refuses before a socket exists whenever identity,
 * bind policy or address assignment does not hold.
 *
 * What the operator supplies, and where it is read from, is
 * `gateway-configuration.ts`.
 */

/** Owner-only: the directory holds the signing key, device records and the audit chain. */
const DATA_DIRECTORY_MODE = 0o700;

export type GatewayRuntime = Readonly<{
  binding: ResolvedHostBinding;
  localControl: LocalControlEndpoint;
  stop(): Promise<void>;
}>;

export type GatewayCompositionOverrides = Readonly<{
  /** Host data environment; injectable so a run can be pointed at a scratch directory. */
  environment?: HostDataEnvironment;
  /** TLS server factory, for a composition test that must not open a real socket. */
  tlsServerFactory?: TlsServerFactory;
}>;

/** Runs one composition step, converting anything it throws into one reason. */
async function step<T>(reason: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GatewayNotConfiguredError) throw error;
    if (error instanceof HostBootstrapError) {
      throw new GatewayNotConfiguredError(error.code, error.message);
    }
    throw new GatewayNotConfiguredError(reason, detailOf(error));
  }
}

/**
 * Builds the process: state stores, the terminal supervisor, the two routers and
 * the two listeners.
 *
 * The remote listener is built lazily inside the {@link GatewayListenerPort}
 * adapter rather than up front, because the TLS server needs the very material
 * {@link HostBootstrap} is the owner of. Constructing it here would mean reading
 * the certificate outside the contract that validates it — and a server built
 * from unvalidated material is exactly the "listening but unverified" state the
 * bootstrap exists to make unreachable.
 */
export async function startGateway(
  overrides: GatewayCompositionOverrides = {},
): Promise<GatewayRuntime> {
  const environment = overrides.environment ?? hostDataEnvironment();
  const dataDirectory = await step("data_directory", async () => {
    const resolved = resolveGatewayDataDirectory(requireHostPlatform(environment));
    await mkdir(resolved, { recursive: true, mode: DATA_DIRECTORY_MODE });
    return resolved;
  });
  const configuration = await readGatewayConfiguration(
    join(dataDirectory, GATEWAY_CONFIGURATION_FILE_NAME),
    dataDirectory,
  );

  const git = new NodeGitRunner();
  const audit = new AppendOnlyAuditFileStore(defaultAuditLogFile(environment));
  const sessions = new AtomicJsonSessionRegistryStore(
    defaultSessionRegistryFile(environment),
    // One id per process lifetime: it is what a later restart compares its own
    // records against, so it must not be stable across two live gateways.
    randomUUID(),
  );
  const deviceAuth = new DeviceAuthService(
    new AtomicJsonDeviceAuthStateStore(defaultDeviceAuthStateFile(environment)),
  );

  const projects = await step("workspace_roots", () =>
    ProjectRegistry.create(configuration.workspaceRoots));
  const membership = new SoloOwnerProjectMembership();
  // NOTE (deliberate, not an oversight): the supervisor is composed WITHOUT the
  // durable session registry. It accepts `registry`, `processes` and
  // `gatewayInstanceId` only as a set, and this package has no production
  // `ProcessIdentityPort` adapter — reading the host process table needs either a
  // signal or a spawned tool, and both are forbidden here. Passing two of three
  // is refused by the supervisor's own constructor, so terminal sessions stay
  // in-memory until that adapter exists. The registry is still the durable home
  // of worktrees, gates and integrations below, which do not need it.
  const terminals = await step("terminal_supervisor", async () =>
    new TerminalSupervisor({
      projects,
      git,
      worktrees: new IsolatedWorktreeService(git, configuration.sessionRoot, sessions),
      terminals: new NodePtyDirectAgentTerminalAdapter(),
    }));
  const agLoopUiOrigin = configuration.agLoopUiOrigin;
  const agLoopUi = agLoopUiOrigin === undefined
    ? undefined
    : await step("ag_loop_ui_origin", async () => new AgLoopUiHttpAdapter(agLoopUiOrigin));

  const router = new RemoteGatewayRouter({
    deviceAuth,
    audit,
    terminals,
    membership,
    projectReads: new ProjectReadService(projects, membership, () => agLoopUi),
  });
  const streams = new TerminalStreamService(terminals);

  const certificates = new FileHostCertificateSource({
    certificateFile: configuration.certificateFile,
    privateKeyFile: configuration.privateKeyFile,
    sourceLabel: "gateway data directory",
  });
  let disposeStreamGateway: (() => void) | undefined;
  const listener: GatewayListenerPort = {
    async start(request) {
      const material = await certificates.load();
      if (!material) {
        throw new Error("Host certificate material disappeared after it was approved");
      }
      const server = createGatewayTlsServer({
        certificate: material.certificatePem,
        privateKey: material.privateKeyPem,
        router,
        ...(overrides.tlsServerFactory === undefined
          ? {}
          : { factory: overrides.tlsServerFactory }),
      });
      // The stream gateway shares the approved socket rather than opening one of
      // its own: an upgrade path on a second listener would be a phone-facing
      // surface the bind policy never saw.
      disposeStreamGateway = attachTerminalWebSocketGateway({
        server,
        deviceAuth,
        membership,
        streams,
      }).dispose;
      return createNodeGatewayListener(server).start(request);
    },
  };

  const bootstrap = new HostBootstrap({
    certificates,
    interfaces: new OsHostNetworkInterfaces(),
    listener,
  });
  const binding = await step("host_bootstrap", async () => {
    await bootstrap.configure({
      address: configuration.bindAddress,
      port: configuration.bindPort,
      ...(configuration.advertisedHost === undefined
        ? {}
        : { advertisedHost: configuration.advertisedHost }),
      ...(configuration.allowLoopback === undefined
        ? {}
        : { allowLoopback: configuration.allowLoopback }),
    });
    return bootstrap.start();
  });

  let localControl: LocalControlListenerHandle;
  try {
    localControl = await step("local_control", () =>
      startLocalControl({
        environment,
        configuration,
        dataDirectory,
        audit,
        deviceAuth,
        git,
        sessions,
        projects,
        terminals,
        bootstrap,
        binding,
      }));
  } catch (error) {
    // The remote socket is already open at this point. A gateway that answered
    // phones but could not be paired or revoked from the host is worse than one
    // that never started, so the failure takes the listener with it.
    disposeStreamGateway?.();
    await bootstrap.stop();
    throw error;
  }

  return Object.freeze({
    binding,
    localControl: localControl.endpoint,
    async stop(): Promise<void> {
      await localControl.close();
      disposeStreamGateway?.();
      await bootstrap.stop();
    },
  });
}

type LocalControlWiring = Readonly<{
  environment: HostDataEnvironment;
  configuration: GatewayConfiguration;
  dataDirectory: string;
  audit: AppendOnlyAuditFileStore;
  deviceAuth: DeviceAuthService;
  git: NodeGitRunner;
  sessions: AtomicJsonSessionRegistryStore;
  projects: ProjectRegistry;
  terminals: TerminalSupervisor;
  bootstrap: HostBootstrap;
  binding: ResolvedHostBinding;
}>;

/**
 * The host-only surface: pairing, revocation, quality gates and local
 * integration. It is deliberately a SECOND listener — `local-control-contract.md`
 * excludes it from the phone-facing server, and sharing one socket would make
 * that exclusion a routing decision instead of a binding one.
 */
async function startLocalControl(wiring: LocalControlWiring): Promise<LocalControlListenerHandle> {
  const { environment, configuration } = wiring;
  const secretFile = defaultLocalControlSecretFile(environment);
  const socketDirectory = defaultLocalControlSocketDirectory(environment);
  const evidenceDirectory = defaultGateEvidenceDirectory(environment);
  await mkdir(socketDirectory, { recursive: true, mode: DATA_DIRECTORY_MODE });
  await mkdir(evidenceDirectory, { recursive: true, mode: DATA_DIRECTORY_MODE });

  const loopback = configuration.localControlLoopbackPort;
  const endpoint = resolveLocalControlEndpoint({
    platform: environment.platform,
    dataDirectory: wiring.dataDirectory,
    runtimeDirectory: socketDirectory,
    ...(loopback === undefined
      ? {}
      : { loopbackFallback: { address: "127.0.0.1", port: loopback } }),
  });
  // A named pipe and a loopback port can prove possession of the secret file but
  // not the identity of the peer, so the weaker assurance is admitted only where
  // the chosen endpoint cannot offer more — never inherited by default.
  const allowCapabilityOnlyAssurance =
    environment.platform === "win32" || loopback !== undefined;

  const gates = new SessionGateService({
    registry: wiring.sessions,
    git: wiring.git,
    runner: new NodeGateCommandRunner(),
    evidence: createFileSessionGateEvidenceRecorder(evidenceDirectory),
    catalogue: configuration.gates,
    sessionRoot: configuration.sessionRoot,
  });
  const router = new LocalControlRouter({
    control: new LocalControlService({
      deviceAuth: wiring.deviceAuth,
      terminals: wiring.terminals,
      hostFingerprint: () => wiring.bootstrap.hostFingerprint(),
      pairingOrigin: () => wiring.binding.pairingOrigin,
    }),
    integrations: new LocalIntegrationService({
      git: wiring.git,
      registry: wiring.sessions,
      gates: createFileSessionGateEvidenceStore(evidenceDirectory),
      // The repository a session's branch is integrated INTO — the registered
      // project root, never the session's own worktree. Resolving it through the
      // registry means an unknown session cannot name a directory of its own.
      repositoryRootOf: async (sessionId) => {
        const snapshot = await wiring.sessions.read();
        const session = snapshot.sessions[sessionId];
        if (!session) throw new Error("Session is not in the registry");
        return wiring.projects.require(session.projectId).projectRoot;
      },
    }),
    gates,
    secrets: createLocalControlSecretFile(secretFile),
    peerPolicy: { allowCapabilityOnlyAssurance },
    audit: wiring.audit,
    ...(loopback === undefined ? {} : { loopbackPort: loopback }),
  });
  const listener = createNodeLocalControlListener(createOsLocalPeerIdentity({ secretFile }));
  return listener.start(endpoint, (request) => router.handle(request));
}

/** Endpoint description for an operator console; a socket path is not printed. */
function describeEndpoint(endpoint: LocalControlEndpoint): string {
  return endpoint.kind === "loopback-http"
    ? `${endpoint.kind} ${endpoint.address}:${endpoint.port}`
    : endpoint.kind;
}

export async function main(): Promise<number> {
  let runtime: GatewayRuntime;
  try {
    runtime = await startGateway();
  } catch (error) {
    const message = error instanceof GatewayNotConfiguredError
      ? error.message
      : `not_configured (unexpected): ${detailOf(error)}`;
    process.stderr.write(`${message}\n`);
    return 1;
  }
  process.stdout.write(`gateway listening, pairing origin ${runtime.binding.pairingOrigin}\n`);
  process.stdout.write(`local control on ${describeEndpoint(runtime.localControl)}\n`);
  const shutdown = (): void => {
    void runtime.stop().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return 0;
}

function startedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (startedDirectly()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
