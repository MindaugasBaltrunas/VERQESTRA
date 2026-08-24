import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the gateway keeps its own runtime state.
 *
 * Session registry, device credentials and the audit chain are host-private:
 * they outlive a checkout, must never reach a commit, and must not be rewritten
 * by anything that rolls the project tree back. The project directories
 * (`AG/state`, `AG/logs`) fail all three — the AG Loop owns them and resets
 * them — so the gateway resolves an OS application-data directory instead and
 * refuses any location inside the repository working tree.
 *
 * Platform mapping:
 * - Windows: `%APPDATA%`, falling back to `%LOCALAPPDATA%` and then to the
 *   conventional `<home>\AppData\Roaming` when a service-like environment
 *   exposes neither.
 * - macOS: `~/Library/Application Support`.
 * - Everything else: XDG — `$XDG_DATA_HOME`, default `~/.local/share`.
 *
 * `AG_MOBILE_GATEWAY_DATA_DIR` overrides the base directory for operators who
 * keep host state on a separate volume; it must be a fully rooted local path
 * outside the repository working tree.
 *
 * TAPATYBĖ (atviras sprendimas, E9): `AG_MOBILE_GATEWAY_DATA_DIR` ir `ag-mobile-gateway`
 * perkelti 1:1. VERQESTRA E6 metu analogiškos eilutės buvo pervardytos (`x-ag-ui-token` →
 * `x-vq-ui-token`, `ag-ui` → `verqestra-ui`), tad čia jos irgi kandidatės — bet tai keičia
 * env kintamojo vardą ir katalogą DISKE, tad sprendimas operatoriaus. Visos tokios eilutės
 * surašytos vienu sąrašu commit'o ataskaitoje, kad pervardijimas būtų vienas veiksmas, o ne
 * šeši spėjimai.
 */

export const GATEWAY_DATA_DIRECTORY_ENV = "AG_MOBILE_GATEWAY_DATA_DIR";

/** Leaf directory appended to the platform base directory. */
export const GATEWAY_DATA_DIRECTORY_NAME = "ag-mobile-gateway";

export type HostDataEnvironment = Readonly<{
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
}>;

export type GatewayDataDirectoryFailure =
  | "not_absolute"
  | "unsupported_root"
  | "inside_project_tree"
  | "no_home_directory"
  | "foreign_platform";

export class GatewayDataDirectoryError extends Error {
  constructor(
    readonly reason: GatewayDataDirectoryFailure,
    detail: string,
  ) {
    super(`Gateway data directory is unusable (${reason}): ${detail}`);
    this.name = "GatewayDataDirectoryError";
  }
}

/**
 * Package root resolved from this module rather than from `process.cwd()`, so
 * the containment check does not depend on where the gateway was started.
 * Compiled output keeps the same depth (`dist/infrastructure/…` mirrors
 * `src/infrastructure/…`).
 */
const packageRoot = resolve(fileURLToPath(import.meta.url), "../../../");

/**
 * The working tree the gateway must stay out of. `AG/` alone is too narrow:
 * anything under the repository root is committable and is rewritten by an AG
 * Loop rollback, which is exactly what host state must survive. The `.git`
 * marker (a directory in a clone, a file in a worktree) is authoritative; the
 * layout fallback covers a checkout without one.
 */
function repositoryRootOf(start: string, home: string): string {
  let current = start;
  for (;;) {
    // The ascent stops at the account's home directory: a dotfiles repository
    // at `~/.git` would otherwise mark every application-data path as a
    // checkout, and the gateway would refuse to start anywhere at all.
    if (current === home) {
      return dirname(dirname(start));
    }
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirname(dirname(start));
    }
    current = parent;
  }
}

const projectRoot = repositoryRootOf(packageRoot, homedir());

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function hostDataEnvironment(): HostDataEnvironment {
  return { platform: process.platform, env: process.env, homeDirectory: homedir() };
}

/**
 * Path semantics follow the environment's platform, not the host's: separator
 * and root rules are what a platform mapping actually differs in, so deriving
 * them from `process.platform` would make the mapping untestable off that host.
 */
function flavourOf(platform: NodeJS.Platform): typeof win32 | typeof posix {
  return platform === "win32" ? win32 : posix;
}

function requireHome(environment: HostDataEnvironment): string {
  if (!flavourOf(environment.platform).isAbsolute(environment.homeDirectory)) {
    throw new GatewayDataDirectoryError(
      "no_home_directory",
      `no absolute home directory to derive an application-data path from (got ${JSON.stringify(environment.homeDirectory)})`,
    );
  }
  return environment.homeDirectory;
}

/** A drive-rooted Windows path — neither UNC nor relative to the current drive. */
function isLocalWindowsRoot(value: string): boolean {
  return !value.startsWith("\\\\") && !value.startsWith("//") && /^[A-Za-z]:[\\/]/.test(value);
}

function platformBaseDirectory(environment: HostDataEnvironment): string {
  const flavour = flavourOf(environment.platform);
  if (environment.platform === "win32") {
    // Bracket prieiga, ne taškas: `noPropertyAccessFromIndexSignature` (VERQESTRA bazinis
    // tsconfig) taško prieigos prie index signature neleidžia. Reikšmės tos pačios.
    const candidates = [environment.env["APPDATA"], environment.env["LOCALAPPDATA"]].filter(
      (candidate): candidate is string =>
        candidate !== undefined && candidate !== "" && flavour.isAbsolute(candidate),
    );
    // A domain-joined host can point %APPDATA% at a roaming SMB share, which
    // would replicate the signing key over the wire onto storage governed by
    // someone else's ACLs. Prefer any local volume the profile offers; only
    // when it offers none fall back to %LOCALAPPDATA%, the variable Windows
    // itself designates as the non-roaming one.
    const local = candidates.find(isLocalWindowsRoot);
    if (local !== undefined) {
      return local;
    }
    const nonRoaming = candidates[candidates.length - 1];
    if (nonRoaming !== undefined) {
      return nonRoaming;
    }
    return flavour.join(requireHome(environment), "AppData", "Roaming");
  }
  if (environment.platform === "darwin") {
    return flavour.join(requireHome(environment), "Library", "Application Support");
  }
  // XDG requires a relative $XDG_DATA_HOME to be ignored, not resolved against
  // the working directory — a relative value would otherwise put credentials
  // wherever the gateway happened to be started, including the project tree.
  const xdg = environment.env["XDG_DATA_HOME"];
  if (xdg && flavour.isAbsolute(xdg)) {
    return xdg;
  }
  return flavour.join(requireHome(environment), ".local", "share");
}

/**
 * `path.isAbsolute` accepts two Windows spellings that would defeat the point
 * of resolving a stable host location: `\state` is absolute only relative to
 * the process's current drive, and a UNC path puts device credentials on a
 * remote share governed by someone else's ACLs.
 *
 * This applies to the operator override alone. A `%APPDATA%` that the OS itself
 * points at a roaming share is a domain-joined host's own decision about where
 * that account's data lives, and refusing it would leave such a host with no
 * usable application-data directory at all.
 */
function requireLocalRoot(override: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    return;
  }
  if (override.startsWith("\\\\") || override.startsWith("//")) {
    throw new GatewayDataDirectoryError(
      "unsupported_root",
      `${GATEWAY_DATA_DIRECTORY_ENV}=${JSON.stringify(override)} is a UNC path; gateway credentials must stay on a local volume`,
    );
  }
  if (!isLocalWindowsRoot(override)) {
    throw new GatewayDataDirectoryError(
      "not_absolute",
      `${GATEWAY_DATA_DIRECTORY_ENV}=${JSON.stringify(override)} is relative to the current drive; give a drive-rooted path`,
    );
  }
}

/**
 * Store factories resolve a path with the environment's flavour and then hand
 * it to a constructor that resolves it again with the host's. Those agree for
 * every real host; a hand-built {@link HostDataEnvironment} naming another
 * platform is a programming error that would make the host `resolve()` reattach
 * the path to `process.cwd()` — inside the project tree, past the containment
 * check. The platform cannot come from configuration, so this only ever fires
 * on misuse.
 */
export function requireHostPlatform(environment: HostDataEnvironment): HostDataEnvironment {
  if (environment.platform !== process.platform) {
    throw new GatewayDataDirectoryError(
      "foreign_platform",
      `a store cannot be opened against a ${environment.platform} path layout on a ${process.platform} host`,
    );
  }
  return environment;
}

/**
 * Absolute application-data directory for gateway state. Throws rather than
 * falling back when the resolved location would land in the repository working
 * tree: silently writing device credentials into the checkout is the failure
 * this function exists to prevent.
 */
export function resolveGatewayDataDirectory(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  const flavour = flavourOf(environment.platform);
  const override = environment.env[GATEWAY_DATA_DIRECTORY_ENV]?.trim();
  let directory: string;
  if (override !== undefined && override !== "") {
    if (!flavour.isAbsolute(override)) {
      throw new GatewayDataDirectoryError(
        "not_absolute",
        `${GATEWAY_DATA_DIRECTORY_ENV}=${JSON.stringify(override)} must be an absolute path`,
      );
    }
    requireLocalRoot(override, environment.platform);
    directory = flavour.resolve(override);
  } else {
    directory = flavour.resolve(
      flavour.join(platformBaseDirectory(environment), GATEWAY_DATA_DIRECTORY_NAME),
    );
  }
  if (isInside(projectRoot, directory)) {
    throw new GatewayDataDirectoryError(
      "inside_project_tree",
      `${directory} is inside the repository working tree ${projectRoot}; gateway state must stay in OS application data`,
    );
  }
  return directory;
}

/** Device pairing challenges, device keys, refresh tokens and the signing key. */
export function defaultDeviceAuthStateFile(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  return flavourOf(environment.platform).join(
    resolveGatewayDataDirectory(environment),
    "device-auth.json",
  );
}

/** Terminal session registry used for restart reconciliation. */
export function defaultSessionRegistryFile(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  return flavourOf(environment.platform).join(
    resolveGatewayDataDirectory(environment),
    "sessions.json",
  );
}

/** Append-only audit hash chain. */
export function defaultAuditLogFile(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  return flavourOf(environment.platform).join(
    resolveGatewayDataDirectory(environment),
    "audit.jsonl",
  );
}

/**
 * Shared secret every local control request is proved against. It belongs with
 * the signing key rather than beside the socket: the socket is a runtime object
 * that a reboot may clear, while this file is the credential that makes the
 * channel usable at all.
 */
export function defaultLocalControlSecretFile(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  return flavourOf(environment.platform).join(
    resolveGatewayDataDirectory(environment),
    "local-control.key",
  );
}

/**
 * Directory the local control socket is created in. It is a subdirectory of its
 * own because the peer attestation checks the ownership and mode of the socket's
 * PARENT: mixing the socket in with state files would tie that check to a
 * directory other components also write to.
 */
export function defaultLocalControlSocketDirectory(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  return flavourOf(environment.platform).join(resolveGatewayDataDirectory(environment), "run");
}

/** Recorded quality-gate evidence, one file per session. */
export function defaultGateEvidenceDirectory(
  environment: HostDataEnvironment = hostDataEnvironment(),
): string {
  return flavourOf(environment.platform).join(resolveGatewayDataDirectory(environment), "gates");
}
