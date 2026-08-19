// Pure guard-root resolution rules. This is a low domain layer: no node/FS/process imports and no
// side effects — only the value types and the total function that maps a project profile's
// source roots onto the frontend/backend/mobile guard-root paths the product-shaped hooks
// (frontend-guard/backend-guard/mobile-guard) key off of. The FS-reading adapter (E4
// infrastructure) loads the profile and checks existence; the domain never touches disk.
// Behaviour etalon: AG_loop domain/project/guard-roots.ts.

/** Product-shaped guard categories that only apply when the matching app root exists. */
export type GuardRootKey = "frontend" | "backend" | "mobile";

/**
 * Safe default guard-root paths: the `apps/web` / `apps/api` / `apps/mobile` convention this
 * project itself and many target projects use. A project with no profile (or a profile whose
 * source roots don't name a frontend/backend/mobile-shaped directory) keeps exactly this
 * behavior — task 888 adds profile awareness without changing the pnpm-triad default.
 */
export const DEFAULT_GUARD_ROOT_PATHS: Record<GuardRootKey, string> = {
  frontend: "apps/web",
  backend: "apps/api",
  mobile: "apps/mobile",
};

// Directory-name patterns that identify a source root as playing the frontend/backend/mobile
// role, independent of where it lives (e.g. a bare `frontend/` at the project root, not only
// `apps/web`). Matched against the LAST path segment of each profile source root.
const GUARD_ROOT_NAME_PATTERNS: Record<GuardRootKey, RegExp> = {
  frontend: /^(web|frontend|client|ui)$/i,
  backend: /^(api|backend|server)$/i,
  mobile: /^mobile$/i,
};

function lastSegment(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Guard roots reach the frontend/mobile Stop hooks as part of a shell command string
 * (`pnpm --dir <root> lint`). The profile that supplies them is project-editable, so a root is
 * adopted only when it is a plain relative path: word characters, dots and dashes per segment,
 * no absolute/drive form, no `..`, and none of the shell metacharacters that would turn the
 * command into a second command. Anything else falls back to the safe default for that role.
 */
const SAFE_GUARD_ROOT = /^[\w.-]+(?:\/[\w.-]+)*$/;

function isSafeGuardRoot(root: string): boolean {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.split("/").some((segment) => segment === "..")) return false;
  return SAFE_GUARD_ROOT.test(normalized);
}

/**
 * Resolves which on-disk path each guard-root role should check. Profile source roots are
 * matched by their last path segment against {@link GUARD_ROOT_NAME_PATTERNS}; a role with no
 * match (including when `sourceRoots` is empty/undefined) falls back to
 * {@link DEFAULT_GUARD_ROOT_PATHS} for that role — this is what keeps the pnpm `apps/web|api|mobile`
 * triad's behavior unchanged whether or not a profile is present.
 */
export function resolveGuardRootPaths(sourceRoots: string[] | undefined): Record<GuardRootKey, string> {
  const resolved: Record<GuardRootKey, string> = { ...DEFAULT_GUARD_ROOT_PATHS };
  if (!sourceRoots || sourceRoots.length === 0) {
    return resolved;
  }
  for (const key of Object.keys(GUARD_ROOT_NAME_PATTERNS) as GuardRootKey[]) {
    const match = sourceRoots.find(
      (root) => isSafeGuardRoot(root) && GUARD_ROOT_NAME_PATTERNS[key].test(lastSegment(root)),
    );
    if (match) {
      resolved[key] = match.replace(/\\/g, "/").replace(/\/+$/, "");
    }
  }
  return resolved;
}
