import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateCommandCatalogue } from "../application/session-gate-policy.js";

/**
 * What the operator configures, and the one failure shape the gateway reports.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): iškelta iš `gateway-main.ts`, kaip
 * `remote-gateway-router.ts` kadaise pasidalino su `-contract` ir `-dto`. Pjūvis
 * prasmingas: čia gyvena tik tai, ką hostas PASAKO apie save, o `gateway-main.ts`
 * lieka tas, kuris iš to surenka procesą.
 *
 * Configuration lives beside the state it belongs to: `gateway.json` in the
 * host-private application-data directory `infrastructure/gateway-data-directory.ts`
 * resolves. Not the project tree (an AG Loop rollback rewrites it), not process
 * arguments (a CLI parser is a dependency this package does not have), and not a
 * scattering of environment variables — the certificate paths, the bind target
 * and the quality-gate catalogue are one decision the operator makes once, and a
 * single reviewable file is what makes it auditable.
 */

export const GATEWAY_CONFIGURATION_FILE_NAME = "gateway.json";

/** Certificate material the operator drops next to the configuration file. */
export const DEFAULT_CERTIFICATE_FILE_NAME = "host-certificate.pem";
export const DEFAULT_PRIVATE_KEY_FILE_NAME = "host-private-key.pem";

export type GatewayConfiguration = Readonly<{
  bindAddress: string;
  bindPort: number;
  advertisedHost: string | undefined;
  allowLoopback: boolean | undefined;
  certificateFile: string;
  privateKeyFile: string;
  workspaceRoots: Readonly<Record<string, string>>;
  sessionRoot: string;
  agLoopUiOrigin: string | undefined;
  localControlLoopbackPort: number | undefined;
  gates: GateCommandCatalogue;
}>;

/**
 * The gateway's single failure shape.
 *
 * `reason` is the machine-readable half — a `HostBootstrapFailureCode` when the
 * bootstrap refused, otherwise the composition step that could not complete. The
 * detail is operator-facing and local: it is written to this process's own
 * stderr before any listener exists, so it never reaches a remote surface.
 */
export class GatewayNotConfiguredError extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`not_configured (${reason}): ${detail}`);
    this.name = "GatewayNotConfiguredError";
    this.reason = reason;
  }
}

type JsonRecord = Readonly<Record<string, unknown>>;

export function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(detail: string): GatewayNotConfiguredError {
  return new GatewayNotConfiguredError("configuration_invalid", detail);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function requireString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: JsonRecord, key: string, label: string): string | undefined {
  return record[key] === undefined ? undefined : requireString(record, key, label);
}

function requireInteger(record: JsonRecord, key: string, label: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {
    throw invalid(`${label}.${key} must be an integer`);
  }
  return value as number;
}

function optionalInteger(record: JsonRecord, key: string, label: string): number | undefined {
  return record[key] === undefined ? undefined : requireInteger(record, key, label);
}

function optionalBoolean(record: JsonRecord, key: string, label: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${label}.${key} must be a boolean`);
  return value;
}

function optionalRecord(root: JsonRecord, key: string): JsonRecord {
  return root[key] === undefined ? {} : asRecord(root[key], key);
}

function readWorkspaceRoots(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value, "workspaceRoots");
  const roots: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    roots[key] = requireString(record, key, "workspaceRoots");
  }
  return Object.freeze(roots);
}

/**
 * Shape only. What a gate command may BE is `application/session-gate-policy.ts`'s
 * decision, and `SessionGateService` applies it in its own constructor —
 * restating those rules here would give the host two answers to one question.
 */
function readGateCatalogue(value: unknown): GateCommandCatalogue {
  if (!Array.isArray(value)) throw invalid("gates must be an array");
  return Object.freeze(value.map((entry, index) => {
    const label = `gates[${index}]`;
    const gate = asRecord(entry, label);
    const args = gate["args"];
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
      throw invalid(`${label}.args must be an array of strings`);
    }
    return Object.freeze({
      name: requireString(gate, "name", label),
      executable: requireString(gate, "executable", label),
      args: Object.freeze([...args as string[]]),
      timeoutMs: requireInteger(gate, "timeoutMs", label),
    });
  }));
}

export async function readGatewayConfiguration(
  configurationFile: string,
  dataDirectory: string,
): Promise<GatewayConfiguration> {
  let text: string;
  try {
    text = await readFile(configurationFile, "utf8");
  } catch (error) {
    // A missing file is the honest "nothing was configured", and it is reached by
    // doing nothing — the same stance `FileHostCertificateSource` takes.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GatewayNotConfiguredError(
        "configuration_missing",
        `no ${GATEWAY_CONFIGURATION_FILE_NAME} in the gateway data directory`,
      );
    }
    throw new GatewayNotConfiguredError("configuration_unreadable", detailOf(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(detailOf(error));
  }
  const root = asRecord(parsed, GATEWAY_CONFIGURATION_FILE_NAME);
  const bind = asRecord(root["bind"], "bind");
  const certificate = optionalRecord(root, "certificate");
  const localControl = optionalRecord(root, "localControl");
  return Object.freeze({
    bindAddress: requireString(bind, "address", "bind"),
    bindPort: requireInteger(bind, "port", "bind"),
    advertisedHost: optionalString(bind, "advertisedHost", "bind"),
    allowLoopback: optionalBoolean(bind, "allowLoopback", "bind"),
    certificateFile: optionalString(certificate, "certificateFile", "certificate")
      ?? join(dataDirectory, DEFAULT_CERTIFICATE_FILE_NAME),
    privateKeyFile: optionalString(certificate, "privateKeyFile", "certificate")
      ?? join(dataDirectory, DEFAULT_PRIVATE_KEY_FILE_NAME),
    workspaceRoots: readWorkspaceRoots(root["workspaceRoots"]),
    sessionRoot: requireString(root, "sessionRoot", GATEWAY_CONFIGURATION_FILE_NAME),
    agLoopUiOrigin: optionalString(root, "agLoopUiOrigin", GATEWAY_CONFIGURATION_FILE_NAME),
    localControlLoopbackPort: optionalInteger(localControl, "loopbackPort", "localControl"),
    gates: readGateCatalogue(root["gates"]),
  });
}
