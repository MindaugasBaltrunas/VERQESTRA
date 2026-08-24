import type { GitHostIssue, GitHostPullRequest } from "../application/ports/git-host-port.js";
import type { GhCliResult } from "./gh-cli-runner.js";

/**
 * Ką pasakė host'o įrankiai, paversta reikšme, kuria galima tikėtis.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `gh-cli-git-host-adapter.ts` buvo 549
 * eilutės). Pjūvis vienas: čia — parsinimas, validacija ir atsisakymai; ten — kokias komandas
 * leisti ir kokia tvarka. Nė viena šio failo funkcija neturi būsenos ir nė viena nekviečia
 * proceso, tad skaidymas nekainuoja enkapsuliacijos.
 *
 * Viena savybė, kurią šis failas laiko: **nė vienas CLI išvesties fragmentas neišeina**. CLI
 * tekstas gali nešti repozitorijos kelią, paskyros vardą arba — remote URL'e — kredencialą,
 * tad parsinimo nesėkmė virsta KODU, o ne to, kas buvo atspausdinta, gabalu.
 */

/** A host-side GitHub failure, reduced to a code the application layer can map. */
export class GitHostError extends Error {
  constructor(
    readonly code:
      | "repository_not_bound"
      | "binding_mismatch"
      | "unsupported_operation"
      | "github_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GitHostError";
  }
}

export const GITHUB_HOSTNAME = "github.com";

/**
 * Stable handle for the host-side connection. The CLI holds one session per
 * host, so the identity is the host and the forge — never anything derived from
 * the credential itself.
 */
export const CONNECTION_ID = "gh:github.com";

/** Reported when `HEAD` is not on a branch; the contract requires a branch string. */
export const DETACHED_BRANCH = "(detached)";

/** GitHub's own owner/repository charset. */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Branch names that are safe as a fixed argument value. */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;

/** `gh issue list --limit` accepts a bounded page; the port's `limit` is clamped into it. */
const MAX_LIST_LIMIT = 100;

/** The account login in `gh auth status`, and nothing else on the line. */
export const ACCOUNT_PATTERN =
  /Logged in to github\.com (?:account|as) ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/;

/** `https://github.com/owner/name/pull/42`, as printed by `gh pr create`. */
export const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/(\d{1,9})$/;

export function unreadable(): GitHostError {
  // Deliberately carries no output fragment: CLI text can contain a repository
  // path, an account name or, in a remote URL, a credential.
  return new GitHostError("github_unavailable", "GitHub CLI returned an unreadable response");
}

export function unavailable(): GitHostError {
  return new GitHostError("github_unavailable", "GitHub CLI query failed");
}

/** Non-negative count, defaulting to zero for anything unexpected. */
export function count(value: string | undefined): number {
  if (value === undefined || value.length === 0 || value.length > 9) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unreadable();
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) throw unreadable();
  return value;
}

function numberField(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw unreadable();
  return value as number;
}

function booleanField(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== "boolean") throw unreadable();
  return value;
}

function labelNames(source: Record<string, unknown>): readonly string[] {
  // Bracket prieiga: `noPropertyAccessFromIndexSignature`. Laukas dar nėra įrodytas
  // egzistuojančiu — įrašas ką tik atėjo iš CLI.
  const labels = source["labels"];
  if (!Array.isArray(labels)) throw unreadable();
  return Object.freeze(labels.map((label) => stringField(recordFrom(label), "name")));
}

export function issueFrom(value: unknown): GitHostIssue {
  const source = recordFrom(value);
  const state = stringField(source, "state").toLowerCase();
  if (state !== "open" && state !== "closed") throw unreadable();
  return Object.freeze({
    number: numberField(source, "number"),
    title: stringField(source, "title"),
    state,
    url: stringField(source, "url"),
    labels: labelNames(source),
    updatedAt: stringField(source, "updatedAt"),
  });
}

export function pullRequestFrom(value: unknown): GitHostPullRequest {
  const source = recordFrom(value);
  const state = stringField(source, "state").toLowerCase();
  if (state !== "open" && state !== "closed" && state !== "merged") throw unreadable();
  return Object.freeze({
    number: numberField(source, "number"),
    title: stringField(source, "title"),
    state,
    draft: booleanField(source, "isDraft"),
    url: stringField(source, "url"),
    headBranch: stringField(source, "headRefName"),
    baseBranch: stringField(source, "baseRefName"),
    updatedAt: stringField(source, "updatedAt"),
  });
}

/**
 * `owner/name` of a GitHub `origin`, or `undefined` for anything else.
 *
 * Every accepted form may carry user information — `https://user:token@host/…`
 * is a legal remote — so the URL is decomposed and discarded here. Only the two
 * validated name segments leave this function, which is what keeps a credential
 * out of every value the adapter returns, logs or raises.
 */
export function parseGitHubRemote(
  remoteUrl: string,
): Readonly<{ owner: string; repository: string }> | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return undefined;
  let hostname: string;
  let repositoryPath: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
    // `hostname` excludes both the user information and the port, so neither can
    // reach the comparison below or the returned value.
    hostname = parsed.hostname;
    repositoryPath = parsed.pathname;
  } else {
    // scp-like form: `[user@]host:owner/name.git`.
    const scpLike = /^(?:[^@/]{1,255}@)?([^:/]{1,255}):(.{1,1024})$/.exec(trimmed);
    // Grupės imamos į vietinius kintamuosius, o ne tikrinamos vietoje:
    // `noUncheckedIndexedAccess` indekso patikros į elemento tipą neperkelia, tad etalono
    // `hostname = scpLike[1]` nekompiliuotųsi. Priimami/atmetami URL nepakito.
    const scpHost = scpLike?.[1];
    const scpPath = scpLike?.[2];
    if (scpHost === undefined || scpPath === undefined) return undefined;
    hostname = scpHost;
    repositoryPath = scpPath;
  }
  if (hostname.toLowerCase() !== GITHUB_HOSTNAME) return undefined;
  const segments = repositoryPath.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
  if (segments.length !== 2) return undefined;
  const [owner, repository] = segments;
  if (owner === undefined || repository === undefined) return undefined;
  for (const segment of [owner, repository]) {
    if (!NAME_PATTERN.test(segment) || segment === "." || segment === "..") return undefined;
  }
  return Object.freeze({ owner, repository });
}

/** Host-fixed write arguments: no control characters, and never flag-shaped. */
export function assertWriteArgument(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("-") ||
    /[\0\r\n]/.test(value)
  ) {
    throw new GitHostError("github_unavailable", `GitHub pull request ${field} is invalid`);
  }
  return value;
}

export function assertBranch(value: string, field: string): string {
  if (!BRANCH_PATTERN.test(value) || value.startsWith("-")) {
    throw new GitHostError("github_unavailable", `GitHub pull request ${field} is invalid`);
  }
  return value;
}

export function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return 1;
  return Math.min(limit, MAX_LIST_LIMIT);
}

export function jsonValue(result: GhCliResult): unknown {
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw unreadable();
  }
}

export function jsonArray(result: GhCliResult): readonly unknown[] {
  const parsed = jsonValue(result);
  if (!Array.isArray(parsed)) throw unreadable();
  return parsed;
}
