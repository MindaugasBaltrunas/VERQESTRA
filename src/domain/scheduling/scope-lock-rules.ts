// Scope lock — grynos verdiktų taisyklės: kas yra kanoninė scope reikšmė, kada lock'as
// dengia kelią, kada du lock'ai konfliktuoja ir ar lease gali rašyti į kelią. Persistencija
// (AG/state store, acquire su TTL/id generavimu) — E3/E4 sluoksniuose.
// Behaviour etalon: AG_loop application/scheduling/scope-lock.ts grynoji pusė, pinned by
// scheduling-verdicts.json (47 kontraktai, VQ-003d).

export const SCOPE_LOCK_SCHEMA_VERSION = 1;

export type ScopeLockKind = "file" | "directory" | "glob" | "contract" | "migration-chain" | "generated";

export type ScopeLockRequest = {
  kind: ScopeLockKind;
  scope: string;
};

/** Lock'o savininkas yra LEASE, ne procesas: netekus lease'o, krenta ir visi jo lock'ai. */
export type ScopeLockOwner = {
  lease_id: string;
  owner_id: string;
  run_id: string;
  worker_id: string;
  task_id: string;
  attempt: number;
  fencing_token: number;
};

export type ScopeLock = {
  lock_id: string;
  kind: ScopeLockKind;
  /** Normalizuota reikšmė (POSIX, be `./`, be trailing `/`). */
  scope: string;
  owner: ScopeLockOwner;
  acquired_at: string;
  expires_at: string;
};

export type ScopeLockRegistry = {
  schema_version: number;
  locks: ScopeLock[];
};

export const EMPTY_SCOPE_LOCK_REGISTRY: ScopeLockRegistry = { schema_version: SCOPE_LOCK_SCHEMA_VERSION, locks: [] };

export class ScopeLockError extends Error {}

/**
 * Kanoninė scope reikšmė. `..`, absoliutūs ir Windows drive keliai atmetami: lock'as,
 * nurodantis už repozitorijos ribų, negali būti nei patikrintas, nei įvykdytas, o path
 * traversal per lock'o reikšmę būtų tiesus kelias pro visus vartus (ISO-2).
 */
export function normalizeScopeValue(scope: string): string {
  const posix = scope.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!posix) throw new ScopeLockError("Scope lock scope must not be empty");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix)) {
    throw new ScopeLockError(`Scope lock scope must be repo-relative: '${scope}'`);
  }
  const withoutDotSlash = posix.replace(/^\.\//, "");
  if (withoutDotSlash.split("/").includes("..")) {
    throw new ScopeLockError(`Scope lock scope must not traverse upwards: '${scope}'`);
  }
  const trimmed = withoutDotSlash.replace(/\/+$/, "");
  if (!trimmed) throw new ScopeLockError(`Scope lock scope must not be empty after normalization: '${scope}'`);
  return trimmed;
}

const SCOPE_LOCK_KINDS: readonly ScopeLockKind[] = ["file", "directory", "glob", "contract", "migration-chain", "generated"];

export function normalizeScopeLockRequest(request: ScopeLockRequest): ScopeLockRequest {
  if (!SCOPE_LOCK_KINDS.includes(request.kind)) {
    throw new ScopeLockError(`Unknown scope lock kind: '${request.kind}'`);
  }
  return { kind: request.kind, scope: normalizeScopeValue(request.scope) };
}

/**
 * Palyginimas be didžiųjų/mažųjų raidžių skirtumo: Windows/macOS failų sistemos yra
 * case-insensitive, tad `Src/A.ts` ir `src/a.ts` ten yra TAS PATS failas; case-sensitive
 * sistemoje tai duoda perteklinį konfliktą — saugi klaidos kryptis.
 */
function comparable(value: string): string {
  return value.toLowerCase();
}

/** Glob'o „kietas" prefiksas — segmentai iki pirmo wildcard'o. */
function solidPrefix(pattern: string): string {
  const solid: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment.includes("*") || segment.includes("?")) break;
    solid.push(segment);
  }
  return solid.join("/");
}

/**
 * Glob semantika: `**` = bet koks gylis, `/*` = vienas lygis, be-wildcard įrašas —
 * prefiksas. Scope PRIVALO reikšti tą patį lock'e ir integracijos ribų patikroje.
 */
function globMatches(pattern: string, value: string): boolean {
  const glob = comparable(pattern);
  const target = comparable(value);
  if (glob === "**" || glob === "*") return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  if (glob.endsWith("/*")) {
    const prefix = glob.slice(0, -2);
    return target.startsWith(`${prefix}/`) && !target.slice(prefix.length + 1).includes("/");
  }
  if (glob.includes("*")) return wildcardPatternMatches(target, glob);
  return target === glob || target.startsWith(`${glob}/`);
}

/** Bendrinis wildcard glob'as (`*` = vienas segmentas, `**` = bet koks gylis). */
function wildcardPatternMatches(file: string, pattern: string): boolean {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[$()+.?[\\\]^{|}]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`).test(file);
}

function pathContains(container: string, value: string): boolean {
  const left = comparable(container);
  const right = comparable(value);
  return right === left || right.startsWith(`${left}/`);
}

/** Ar konkretus kelias patenka į vieno lock'o valdomą sritį. */
export function scopeCovers(lock: Pick<ScopeLock, "kind" | "scope">, repoRelativePath: string): boolean {
  const value = normalizeScopeValue(repoRelativePath);
  switch (lock.kind) {
    case "glob":
      return globMatches(lock.scope, value);
    case "file":
      return comparable(lock.scope) === comparable(value);
    case "directory":
    case "generated":
    case "contract":
      // Kontraktas paprastai yra index.ts arba modulio paviršius: užrakinus jį,
      // užrakinama ir viskas, kas po juo publikuojama.
      return pathContains(lock.scope, value);
    case "migration-chain":
      // Grandinė yra ne tik jos katalogas: bet koks failas grandinės kelyje priklauso jai.
      return pathContains(lock.scope, value);
  }
}

/**
 * Ar du lock'ai persidengia. Migracijų grandinės serializuojamos GLOBALIAI: dvi grandinės
 * dalijasi viena schemos versijų istorija, todėl lygiagretus taikymas duoda neatkuriamą
 * tvarką — sąmoningai stipresnė taisyklė nei kelių persidengimas.
 */
export function scopesConflict(
  left: Pick<ScopeLock, "kind" | "scope">,
  right: Pick<ScopeLock, "kind" | "scope">,
): boolean {
  if (left.kind === "migration-chain" && right.kind === "migration-chain") return true;

  if (left.kind === "glob" && right.kind === "glob") {
    if (globMatches(left.scope, right.scope) || globMatches(right.scope, left.scope)) return true;
    const leftPrefix = solidPrefix(left.scope);
    const rightPrefix = solidPrefix(right.scope);
    // Du glob'ai be bendro kieto prefikso vis tiek gali persidengti (pvz. `**/index.ts`
    // ir `src/**`), todėl tuščias prefiksas laikomas „gali persidengti" (fail-closed).
    if (!leftPrefix || !rightPrefix) return true;
    return pathContains(leftPrefix, rightPrefix) || pathContains(rightPrefix, leftPrefix);
  }

  if (left.kind === "glob") return globMatches(left.scope, right.scope) || pathContains(right.scope, solidPrefix(left.scope));
  if (right.kind === "glob") return globMatches(right.scope, left.scope) || pathContains(left.scope, solidPrefix(right.scope));

  return pathContains(left.scope, right.scope) || pathContains(right.scope, left.scope);
}

/** Nepasibaigęs lock'as. Neperskaitoma `expires_at` laikoma pasibaigusia — lock'as niekada neužstringa amžiams. */
export function isScopeLockActive(lock: ScopeLock, now: Date): boolean {
  const expiresAt = new Date(lock.expires_at).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return now.getTime() < expiresAt;
}

export function activeScopeLocks(registry: ScopeLockRegistry, now: Date): ScopeLock[] {
  return registry.locks.filter((lock) => isScopeLockActive(lock, now));
}

/** Atlaisvina visus vieno lease'o lock'us. Naudojamas ir po sėkmės, ir po lease perėmimo. */
export function releaseScopeLocks(registry: ScopeLockRegistry, leaseId: string): ScopeLockRegistry {
  return {
    schema_version: SCOPE_LOCK_SCHEMA_VERSION,
    locks: registry.locks.filter((lock) => lock.owner.lease_id !== leaseId),
  };
}

/** Išvalo pasibaigusius lock'us — vienintelis kelias, kuriuo krachas neužrakina scope amžiams. */
export function pruneScopeLocks(registry: ScopeLockRegistry, now: Date): ScopeLockRegistry {
  return { schema_version: SCOPE_LOCK_SCHEMA_VERSION, locks: activeScopeLocks(registry, now) };
}

export type ScopeLockAuthorityStatus = "unlocked" | "owned" | "locked-by-other";

export type ScopeLockAuthority = {
  status: ScopeLockAuthorityStatus;
  ok: boolean;
  reason: string;
  lock?: ScopeLock;
};

/**
 * Ar šis lease gali rašyti į konkretų kelią. Svetimas lock'as visada nusveria savą: jei
 * kelią apima ir savas, ir svetimas, verdiktas yra `locked-by-other` — kitaip užtektų
 * pasiimti platų `**` lock'ą, kad būtų apeiti visi kitų workerių siauri lock'ai.
 */
export function authorizeScopedPath(
  registry: ScopeLockRegistry,
  repoRelativePath: string,
  leaseId: string | undefined,
  now: Date,
): ScopeLockAuthority {
  let normalized: string;
  try {
    normalized = normalizeScopeValue(repoRelativePath);
  } catch (error: unknown) {
    return { status: "locked-by-other", ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const covering = activeScopeLocks(registry, now).filter((lock) => scopeCovers(lock, normalized));
  const firstCovering = covering[0];
  if (firstCovering === undefined) {
    return { status: "unlocked", ok: true, reason: `${normalized} nėra užrakintas` };
  }

  const foreign = covering.find((lock) => lock.owner.lease_id !== leaseId);
  if (foreign) {
    return {
      status: "locked-by-other",
      ok: false,
      reason: `${normalized} priklauso ${foreign.kind} lock'ui '${foreign.scope}' (task ${foreign.owner.task_id}, lease ${foreign.owner.lease_id})`,
      lock: foreign,
    };
  }

  return { status: "owned", ok: true, reason: `${normalized} priklauso šio lease'o scope`, lock: firstCovering };
}
