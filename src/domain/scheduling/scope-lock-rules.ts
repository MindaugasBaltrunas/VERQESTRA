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

/**
 * Tuščio registro reikšmė. BE KVIETĖJO, bet tai tik patogumo konstanta — ne mechanikos dalis.
 *
 * SLUOKSNIS JAU PRIJUNGTAS (2026-08-24, operatoriaus radinys P2): iki tol čia buvo parašyta, kad
 * registro „NIEKAS NEUŽPILDO", tad `authorizeScopedWrite` skaito amžinai tuščią registrą ir visada
 * leidžia. Nebe: `acquireScopeLocksInStore` kviečiamas `wave-provisioning` PRIEŠ dispatch'ą, o
 * `releaseScopeLocksInStore` — `worker-lease-store.releaseWorkerLease`, tad lock'ai krenta kartu su
 * lease'u (`ScopeLockOwner` taisyklė). Aprašas apie inertiškumą liko po prijungimo ir kurį laiką
 * skelbė spragą, kurios nebėra.
 */
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

/**
 * Rūšys, kurias scope lock'ai apskritai pripažįsta. Eksportuota, kad kvietėjai, verčiantys savo
 * aprėptį į prašymus (pvz. `wave-provisioning` iš write set'o), filtruotų pagal TĄ PATĮ sąrašą,
 * kurį tikrina `normalizeScopeLockRequest` — antras sąrašas išsiskirtų tyliai.
 */
export const SCOPE_LOCK_KINDS: readonly ScopeLockKind[] = ["file", "directory", "glob", "contract", "migration-chain", "generated"];

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

/**
 * Šablono uodegos segmentai po bendro kieto prefikso, arba `null`, jei uodega netinka
 * segmentų skaičiavimui. `null` grąžinamas trimis atvejais ir KIEKVIENAS yra soundness'o
 * dalis, ne atsargumas:
 *
 * 1. Tuščia uodega. Šablonas be wildcard'ų krenta į `globMatches` be-`*` šaką, o ji reiškia
 *    KATALOGĄ (`target === glob` arba `target.startsWith(glob + "/")`), tad atitinka bet kokį
 *    gylį. Segmentų skaičius tokiam šablonui neapibrėžtas.
 * 2. Dvigubos žvaigždutės seka bet kurioje segmento vietoje — ne tik kai visas segmentas yra
 *    dviguba žvaigždutė. Pvz. `src/a__b.ts` (kur `__` yra dviguba žvaigždutė) virsta
 *    `^src/a.*b\.ts$`, o `.*` KERTA pasvirąjį brūkšnį: segmentų skaičiavimas meluotų.
 * 3. `?` bet kurioje vietoje — priežastis žemiau, prie paties patikrinimo.
 *
 * Mažosios raidės daromos VISAM šablonui vienu kartu prieš `split`, lygiai kaip `globMatches`
 * daro `comparable(pattern)` prieš lyginimą. Segmentų normalizavimas atskirai duotų kitą
 * rezultatą tik tada, jei skirtųsi nuo viso string'o normalizavimo — o skirtis reikštų, kad
 * uodegos lyginamos ne ta pačia forma, kuria jas mato `globMatches`.
 */
function globTailSegments(pattern: string, prefixSegmentCount: number): string[] | null {
  const segments = comparable(pattern).split("/").slice(prefixSegmentCount);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    // `?` be nė vienos `*` patenka į TĄ PAČIĄ be-`*` katalogo šaką (1 punktas), nors `solidPrefix`
    // jį jau laiko wildcard'u. Kontrpavyzdys, kurį šis bail'as uždaro: `src/a?.ts` ir
    // `src/<žvaigždutė>/y.log` abu atitinka kelią `src/a?.ts/y.log` (pirmasis — kaip katalogo
    // prefiksas, antrasis — kaip vienas lygis), nors uodegų ilgiai skiriasi (1 vs 2).
    // Pagrindimas yra „be-`*` šaka = katalogo semantika", NE escape'inimo nesutapimas.
    if (!segment || segment.includes("**") || segment.includes("?")) return null;
  }
  return segments;
}

/**
 * Ar du to paties lygio segmentai įrodomai negali sutapti nė viename kelyje.
 *
 * Pagrindas: bet kuri `wildcardPatternMatches` atitiktis privalo prasidėti literaliu prefiksu
 * iki pirmos `*` ir baigtis literaliu sufiksu po paskutinės `*`. Jei abi pusės turi `*`, tas
 * pats string'as privalėtų prasidėti abiem prefiksais ir baigtis abiem sufiksais — o to paties
 * string'o prefiksai (sufiksai) visada palyginami tarpusavyje. Nepalyginami prefiksai (arba
 * nepalyginami sufiksai) reiškia tuščią sankirtą.
 *
 * Taisyklė sąmoningai NEPILNA: `a*` ir `ab*` čia lieka „gali sutapti", nors jų sankirta ir
 * netuščia. Nepilnumas visada krypsta į `true` — prarandamas lygiagretumas, ne saugumas.
 */
function segmentsProvablyDisjoint(left: string, right: string): boolean {
  const leftHasStar = left.includes("*");
  const rightHasStar = right.includes("*");
  if (!leftHasStar && !rightHasStar) return left !== right;
  if (!leftHasStar) return !wildcardPatternMatches(left, right);
  if (!rightHasStar) return !wildcardPatternMatches(right, left);
  const leftHead = left.slice(0, left.indexOf("*"));
  const rightHead = right.slice(0, right.indexOf("*"));
  if (!leftHead.startsWith(rightHead) && !rightHead.startsWith(leftHead)) return true;
  const leftTail = left.slice(left.lastIndexOf("*") + 1);
  const rightTail = right.slice(right.lastIndexOf("*") + 1);
  return !leftTail.endsWith(rightTail) && !rightTail.endsWith(leftTail);
}

/**
 * Ar dviejų šablonų uodegos po bendro kieto prefikso įrodomai nesikerta.
 *
 * `false` reiškia „NEĮRODYTA", niekada „persidengia". Fail-closed kryptis nesilpninama: kiekvienas
 * kelias, kuriuo šis įrodymas nepasiekia išvados, grįžta į ankstesnį „gali persidengti" verdiktą.
 *
 * Segmentų skaičiaus taisyklė (`N !== M` reiškia nesikertančias aibes) yra sound'i, nes
 * skaičiuojami pasvirieji brūkšniai: visos uodegos jau praėjo `globTailSegments`, tad jose nėra
 * dvigubos žvaigždutės, o vieno lygio `[^/]*` brūkšnių NEPRIDEDA. Vadinasi N segmentų šablonas
 * atitinka tik N segmentų kelius, o M segmentų — tik M segmentų kelius.
 */
function globTailsProvablyDisjoint(leftPattern: string, rightPattern: string, prefixSegmentCount: number): boolean {
  const leftTail = globTailSegments(leftPattern, prefixSegmentCount);
  const rightTail = globTailSegments(rightPattern, prefixSegmentCount);
  if (!leftTail || !rightTail) return false;
  if (leftTail.length !== rightTail.length) return true;
  for (const [index, leftSegment] of leftTail.entries()) {
    const rightSegment = rightTail[index];
    if (rightSegment === undefined) return false;
    if (segmentsProvablyDisjoint(leftSegment, rightSegment)) return true;
  }
  return false;
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
    // Įrodomo nepersidengimo šaka (task 035): kai kieti prefiksai LYGŪS, uodegų aibės gali būti
    // įrodomai tuščios sankirtos — tada `src/tests/a-*.test.ts` ir `src/tests/b-*.test.ts` nebeatima
    // vienas kito lygiagretumo. Nepilnumas sąmoningas: reikalaujama būtent LYGYBĖS, tad `src/*.ts`
    // prieš `src/tests/*.ts` lieka `true`, nors uodegos ir ten nesikerta. Apibendrinimas skirtingo
    // gylio prefiksams — atskira užduotis; čia svarbiau, kad kiekviena šakos sąlyga būtų sound'i.
    if (
      comparable(leftPrefix) === comparable(rightPrefix) &&
      globTailsProvablyDisjoint(left.scope, right.scope, leftPrefix.split("/").length)
    ) {
      return false;
    }
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

/**
 * Išvalo pasibaigusius lock'us — vienintelis kelias, kuriuo krachas neužrakina scope amžiams.
 *
 * BE KVIETĖJO — ir po sluoksnio prijungimo (2026-08-24) tai jau NE spraga, o perteklius.
 *
 * Ankstesnis aprašas įspėjo: „prijungiant scope lock'us ŠI funkcija privalo būti prijungta KARTU,
 * be jos pirmas krachas užrakintų scope amžiams". Įspėjimas PATIKRINTAS ir nepasitvirtino —
 * galiojimas jau filtruojamas ABIEJOSE pusėse per `activeScopeLocks`:
 *
 *   - rašymo pusė: `acquireScopeLocks` registrą persist'ina iš `retained`, tad pasibaigę lock'ai
 *     nukrenta per KIEKVIENĄ įgijimą (ir konflikto, ir sėkmės kelyje);
 *   - skaitymo pusė: `authorizeScopedPath` dengiančius lock'us renka irgi iš `activeScopeLocks`.
 *
 * Todėl kritusio workerio lock'as nustoja veikti pasibaigus TTL be jokio atskiro šveitėjo. Ši
 * funkcija paliekama kaip aiškus vienkartinio išvalymo įrankis, o ne kaip trūkstama grandis.
 */
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
