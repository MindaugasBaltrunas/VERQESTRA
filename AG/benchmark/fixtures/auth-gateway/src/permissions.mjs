/**
 * Role to permission resolution. Deny by default: a role this table does not
 * know resolves to no permissions at all, because the alternative — treating an
 * unrecognised role as an administrator — is how a typo becomes a breach.
 */

export const ROLE_PERMISSIONS = Object.freeze({
  viewer: Object.freeze(["task:read"]),
  editor: Object.freeze(["task:read", "task:write"]),
  approver: Object.freeze(["task:read", "task:write", "task:approve"]),
  admin: Object.freeze(["task:read", "task:write", "task:approve", "user:manage"]),
});

/**
 * @param {readonly string[]} roles
 * @returns {string[]}
 */
export function permissionsFor(roles) {
  const granted = new Set();
  for (const role of roles) {
    // Own keys only: an index lookup would find `constructor` and `toString` on
    // the prototype, and a role named after one of them would resolve to
    // something that is not a permission list at all.
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) continue;
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted].sort();
}

/**
 * @param {readonly string[]} roles
 * @param {string} permission
 * @returns {boolean}
 */
export function can(roles, permission) {
  return permissionsFor(roles).includes(permission);
}

/**
 * Throws rather than returning false, so a caller cannot ignore the answer by
 * forgetting an `if`.
 *
 * @param {readonly string[]} roles
 * @param {string} permission
 */
export function requirePermission(roles, permission) {
  if (!can(roles, permission)) {
    throw new Error(`Permission "${permission}" is not granted to these roles.`);
  }
}
