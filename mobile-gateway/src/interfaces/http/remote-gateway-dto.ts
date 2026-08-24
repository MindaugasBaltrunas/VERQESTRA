import type { TokenPair } from "../../application/device-auth-service.js";
import {
  InvalidHttpRequestError,
  MAX_HTTP_BODY_BYTES,
  type GatewayHttpRequest,
} from "./remote-gateway-contract.js";

/**
 * Nuotolinio šliuzo užklausų VALIDATORIAI: kūno dekodavimas, DTO formos ir užklausos
 * parametrų ribos.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas). Nė viena šio failo funkcija nesiekia serviso ir
 * neturi būsenos — jos tik atsako „ar tai teisėta forma", metdamos
 * {@link InvalidHttpRequestError}.
 *
 * NUKRYPIMAS (formos, ne elgesio): prieiga prie neparsinto JSON kūno laukų ir prie HTTP
 * antraščių eina per bracket, o ne per tašką — `noPropertyAccessFromIndexSignature`. Taisyklė
 * čia net naudinga: `value` yra `Record<string, unknown>`, tad nė vienas laukas dar nėra
 * įrodytas egzistuojančiu.
 */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PairingRedeemDto = {
  oneTimeCode: string;
  deviceName: string;
  devicePublicKey: string;
  nonce: string;
  proof: string;
};

export type RefreshDto = {
  deviceId: string;
  refreshToken: string;
  nonce: string;
  proof: string;
};

export type CreateTerminalSessionDto = {
  provider: "claude-code" | "codex";
  workspaceMode: "isolated-worktree";
  cols: number;
  rows: number;
};

export type LeaseFenceDto = {
  requestId: string;
  leaseId: string;
  leaseGeneration: number;
};

export type TerminalInputDto = LeaseFenceDto & {
  inputId: string;
  source: "keyboard" | "voice";
  text: string;
};

/** Rejects any query parameter, including a repeated one, outside `allowed`. */
export function allowQueryParameters(url: URL, allowed: readonly string[]): void {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== new Set(keys).size || keys.some((key) => !allowed.includes(key))) {
    throw new InvalidHttpRequestError("Query parameters are not allowed on this endpoint");
  }
}

/**
 * Bounded integer query parameter. The bound is the gateway's, not the AG Loop
 * UI's: an out-of-range value is refused rather than silently clamped, so a
 * client never believes it asked for more than it received.
 */
export function boundedQueryInteger(
  url: URL,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  if (!/^[0-9]{1,6}$/.test(raw)) {
    throw new InvalidHttpRequestError(`Query parameter ${name} is invalid`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < minimum || value > maximum) {
    throw new InvalidHttpRequestError(`Query parameter ${name} is invalid`);
  }
  return value;
}

function bodyText(body: GatewayHttpRequest["body"]): string {
  if (body === undefined) {
    throw new InvalidHttpRequestError("JSON request body is required");
  }
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  if (bytes.byteLength > MAX_HTTP_BODY_BYTES) {
    throw new InvalidHttpRequestError("Request body exceeds the 32768 byte limit");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidHttpRequestError("Request body must be valid UTF-8");
  }
}

export function jsonObject(request: GatewayHttpRequest): Record<string, unknown> {
  const contentType = request.headers?.["content-type"]?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new InvalidHttpRequestError("Content-Type must be application/json");
  }
  let value: unknown;
  try {
    value = JSON.parse(bodyText(request.body));
  } catch (error) {
    if (error instanceof InvalidHttpRequestError) {
      throw error;
    }
    throw new InvalidHttpRequestError("Request body must contain valid JSON");
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new InvalidHttpRequestError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactStringDto<T extends Record<string, string>>(
  value: Record<string, unknown>,
  keys: readonly (keyof T & string)[],
): T {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new InvalidHttpRequestError("Request contains missing or unsupported fields");
  }
  for (const key of keys) {
    if (typeof value[key] !== "string") {
      throw new InvalidHttpRequestError(`Field ${key} must be a string`);
    }
  }
  return value as T;
}

export function pairingDto(request: GatewayHttpRequest): PairingRedeemDto {
  const dto = exactStringDto<PairingRedeemDto>(jsonObject(request), [
    "oneTimeCode",
    "deviceName",
    "devicePublicKey",
    "nonce",
    "proof",
  ]);
  if (
    dto.oneTimeCode.length < 20 ||
    dto.deviceName.trim().length === 0 ||
    dto.deviceName.length > 80 ||
    dto.nonce.length < 16 ||
    dto.devicePublicKey.length === 0 ||
    dto.proof.length === 0
  ) {
    throw new InvalidHttpRequestError("Pairing request fields are invalid");
  }
  return dto;
}

export function refreshDto(request: GatewayHttpRequest): RefreshDto {
  const dto = exactStringDto<RefreshDto>(jsonObject(request), [
    "deviceId",
    "refreshToken",
    "nonce",
    "proof",
  ]);
  if (
    !UUID_PATTERN.test(dto.deviceId) ||
    dto.refreshToken.length < 20 ||
    dto.nonce.length < 16 ||
    dto.proof.length === 0
  ) {
    throw new InvalidHttpRequestError("Refresh request fields are invalid");
  }
  return dto;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new InvalidHttpRequestError("Request contains missing or unsupported fields");
  }
}

export function integerField(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new InvalidHttpRequestError(`Field ${field} is invalid`);
  }
  return value as number;
}

export function createTerminalSessionDto(request: GatewayHttpRequest): CreateTerminalSessionDto {
  const value = jsonObject(request);
  exactKeys(value, ["provider", "workspaceMode", "cols", "rows"]);
  const provider = value["provider"];
  const workspaceMode = value["workspaceMode"];
  if (
    (provider !== "claude-code" && provider !== "codex") ||
    workspaceMode !== "isolated-worktree"
  ) {
    throw new InvalidHttpRequestError("Terminal provider or workspace mode is invalid");
  }
  return {
    provider,
    workspaceMode,
    cols: integerField(value["cols"], "cols", 20, 500),
    rows: integerField(value["rows"], "rows", 5, 300),
  };
}

export function leaseFence(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): LeaseFenceDto {
  exactKeys(value, expectedKeys);
  const requestId = value["requestId"];
  const leaseId = value["leaseId"];
  if (
    typeof requestId !== "string" ||
    !UUID_PATTERN.test(requestId) ||
    typeof leaseId !== "string" ||
    !UUID_PATTERN.test(leaseId)
  ) {
    throw new InvalidHttpRequestError("Terminal lease fence is invalid");
  }
  return {
    requestId,
    leaseId,
    leaseGeneration: integerField(
      value["leaseGeneration"],
      "leaseGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function terminalInputDto(request: GatewayHttpRequest): TerminalInputDto {
  const value = jsonObject(request);
  const fence = leaseFence(value, [
    "requestId",
    "leaseId",
    "leaseGeneration",
    "inputId",
    "source",
    "text",
  ]);
  const inputId = value["inputId"];
  const source = value["source"];
  const text = value["text"];
  if (
    typeof inputId !== "string" ||
    !UUID_PATTERN.test(inputId) ||
    (source !== "keyboard" && source !== "voice") ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > 16_384
  ) {
    throw new InvalidHttpRequestError("Terminal input is invalid");
  }
  return {
    ...fence,
    inputId,
    source,
    text,
  };
}

export function idempotencyKey(request: GatewayHttpRequest): string {
  const key = request.headers?.["idempotency-key"];
  if (!key || key.length < 16 || key.length > 160 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new InvalidHttpRequestError("Idempotency-Key header is invalid");
  }
  return key;
}

export function tokenBody(tokens: TokenPair): Record<string, unknown> {
  return {
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}
