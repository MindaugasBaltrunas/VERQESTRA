// Generic path normalization and project-root containment. Pure — no filesystem access
// (the gate enforces it). Behaviour etalon: AG_loop core/paths.ts pure exports, pinned by
// the cross-platform-paths and comparable-posix-path test suites (ported alongside).
//
// THREE distinct normalizations that LOOK alike and must never be merged:
//  - toPosixPath: separators only (no `./` stripping, no trim);
//  - toComparablePosixPath: ONE leading `./` + trim — for equality/startsWith/glob checks;
//  - stripLeadingDotSlash: ALL leading `./` repeats — for path construction.
// `".//a"` yields `"/a"` vs `"a"` respectively; the difference flows into startsWith checks.

import path from "node:path";

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function stripTrailingSlash(filePath: string): string {
  const normalized = toPosixPath(filePath);
  if (normalized === "/") return normalized;
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

export function stripLeadingDotSlash(filePath: string): string {
  return toPosixPath(filePath).replace(/^\.\/+/, "");
}

/** Path prepared for COMPARISON with another path. `?? ""` guards untyped (JSON) input. */
export function toComparablePosixPath(value: string): string {
  return (value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

// Case-folds ONLY Windows drive-letter paths (`C:/...`) — repo-relative paths stay
// case-sensitive, so Windows and Linux verdicts agree on everything but the drive.
function comparablePath(filePath: string): string {
  const normalized = stripTrailingSlash(stripLeadingDotSlash(filePath));
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function normalizeProjectPath(projectRoot: string, filePath: string): string {
  const normalizedRoot = stripTrailingSlash(toPosixPath(projectRoot));
  const comparableRoot = comparablePath(normalizedRoot);
  let normalized = stripLeadingDotSlash(filePath);
  const comparable = comparablePath(normalized);

  if (comparable === comparableRoot) {
    return "";
  }
  if (comparable.startsWith(`${comparableRoot}/`)) {
    normalized = normalized.slice(comparableRoot.length + 1);
  }
  return stripLeadingDotSlash(normalized);
}

export function isProjectRelativePath(filePath: string): boolean {
  const normalized = toPosixPath(filePath);
  return !path.posix.isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized);
}

export function isPathInsideProject(projectRoot: string, filePath: string): boolean {
  const relative = normalizeProjectPath(projectRoot, filePath);
  return relative === "" || (isProjectRelativePath(relative) && !relative.split("/").includes(".."));
}

export type ResolveProjectPathOptions = {
  allowAbsoluteInsideRoot?: boolean;
  allowedPrefixes?: string[];
  extension?: string;
};

/**
 * Resolves a candidate against the project root, refusing escapes, wrong extensions and
 * paths outside the allowed prefixes. Pure: never touches the filesystem; throws `Error`
 * with the byte-stable messages the CLI exit contracts pin.
 */
export function resolveProjectPath(
  projectRoot: string,
  candidate: string,
  options: ResolveProjectPathOptions = {},
  label = "task file",
): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }

  const allowAbsoluteInsideRoot = options.allowAbsoluteInsideRoot ?? true;
  if (path.isAbsolute(trimmed) && !allowAbsoluteInsideRoot) {
    throw new Error(`${label} must be relative`);
  }

  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(resolvedRoot, trimmed);
  const relative = path.relative(resolvedRoot, resolved);
  const relativePosix = toPosixPath(relative);
  if (relative === "" || relativePosix === ".." || relativePosix.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes project root`);
  }

  const extension = options.extension;
  if (extension && path.extname(resolved).toLowerCase() !== extension.toLowerCase()) {
    throw new Error(`${label} must be a ${extension} file`);
  }

  const allowedPrefixes = options.allowedPrefixes ?? [];
  if (allowedPrefixes.length > 0) {
    const comparableRelative = comparablePath(toPosixPath(relative));
    const allowed = allowedPrefixes.some((prefix) => {
      if (path.isAbsolute(prefix)) {
        throw new Error(`${label} allowed prefix must be relative`);
      }
      const comparablePrefix = comparablePath(stripTrailingSlash(stripLeadingDotSlash(prefix)));
      return comparableRelative === comparablePrefix || comparableRelative.startsWith(`${comparablePrefix}/`);
    });
    if (!allowed) {
      throw new Error(`${label} must be inside ${allowedPrefixes.join(", ")}`);
    }
  }

  return resolved;
}
