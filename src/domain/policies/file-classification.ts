// Failų klasifikavimo GRYNOSIOS taisyklės guard'ams (etalonas: AG_loop hooks/
// file-classifiers.ts). Jokio IO — įrodymus surenka hook adapteris, sprendimą priima šios
// funkcijos. VERQESTRA skirtumai: skipinamų kelių sąrašas naudoja vq/ runtime šaknį, o
// etalono `node:path` pakeistas grynu vardo išskyrimu — domain sluoksnis node API neliečia
// (architektūros vartai jį domain'e draudžia visiškai).

/** Paskutinis kelio segmentas; separatoriai normalizuojami, tad veikia ir Windows formoms. */
function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Keliai, kurių slaptukų skeneris neliečia. Du skirtingi motyvai, kuriuos verta skirti:
 * sugeneruotas `dist/` praleidžiamas dėl SELF-MATCH (į jį sukompiliuoti patys skenerio
 * regex'ai), o runtime katalogai (`vq/state`, `vq/logs`, `vq/supervisor`) — todėl, kad juose
 * guli orkestratoriaus išvestis, ne produkto kodas. `.env*` failai praleidžiami sąmoningai:
 * tai sankcionuota lokalių kredencialų vieta, ir jų skenavimas duotų amžiną false positive.
 */
export function shouldSkipSecretScan(filePath: string): boolean {
  const basename = baseName(filePath);
  return (
    !filePath ||
    filePath.startsWith(".git/") ||
    filePath.startsWith("node_modules/") ||
    filePath.startsWith("dist/") ||
    filePath.startsWith("build/") ||
    filePath.startsWith("coverage/") ||
    filePath.startsWith("vq/logs/") ||
    filePath.startsWith("vq/state/") ||
    filePath.startsWith("vq/supervisor/") ||
    filePath.endsWith(".lock") ||
    filePath === "pnpm-lock.yaml" ||
    basename === ".env" ||
    basename.startsWith(".env.")
  );
}

export function isPackageJsonPath(filePath: string): boolean {
  return (filePath === "package.json" || filePath.endsWith("/package.json")) && !filePath.startsWith("node_modules/");
}

/** Package manager'iai, kuriuos guard'as supranta. Tvarka čia nieko nereiškia. */
export type PackageManagerName = "npm" | "yarn" | "pnpm" | "bun";

const LOCKFILE_NAMES_BY_MANAGER: Record<PackageManagerName, string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

const ALL_LOCKFILE_NAMES = Object.values(LOCKFILE_NAMES_BY_MANAGER).flat();

export function lockfileNamesForManager(manager: PackageManagerName): string[] {
  return LOCKFILE_NAMES_BY_MANAGER[manager];
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lockfileSuffixPattern(names: string[]): RegExp {
  return new RegExp(`(^|/)(${names.map(escapeRegExpLiteral).join("|")})$`);
}

export function isLockfilePath(filePath: string): boolean {
  return lockfileSuffixPattern(ALL_LOCKFILE_NAMES).test(filePath) && !filePath.startsWith("node_modules/");
}

/**
 * Lockfile'as yra „svetimas" TIK target projekto package manager'io atžvilgiu: bet kuris
 * lockfile'as, priklausantis KITAM valdikliui nei `manager`. Be išspręsto valdiklio (ne-Node
 * target arba šviežias Node projektas be įrodymų) svetimų nėra — task 886.
 */
export function isForeignLockfilePath(filePath: string, manager: PackageManagerName | undefined): boolean {
  if (!manager || filePath.startsWith("node_modules/")) return false;
  const ownNames = new Set(lockfileNamesForManager(manager));
  const foreignNames = ALL_LOCKFILE_NAMES.filter((name) => !ownNames.has(name));
  if (foreignNames.length === 0) return false;
  return lockfileSuffixPattern(foreignNames).test(filePath);
}

/** Įrodymai, kuriuos surenka FS liečiantis hook'as; pats resolveris lieka grynas. */
export type PackageManagerEvidence = {
  profilePackageManager?: string;
  packageJsonPackageManager?: string;
  existingRootLockfileManager?: PackageManagerName;
};

export function normalizePackageManagerName(value: string | undefined): PackageManagerName | undefined {
  if (!value) return undefined;
  const name = value.split("@")[0]?.trim().toLowerCase();
  return name === "npm" || name === "yarn" || name === "pnpm" || name === "bun" ? name : undefined;
}

/**
 * Target projekto package manager'is. Pirmumas: projekto profilio `package_manager`, tada
 * paties target `package.json#packageManager`, tada tas valdiklis, kurio lockfile'as jau guli
 * projekto šaknyje. `undefined`, kai nė vienas įrodymo neduoda (task 886).
 */
export function resolveTargetPackageManager(evidence: PackageManagerEvidence): PackageManagerName | undefined {
  return (
    normalizePackageManagerName(evidence.profilePackageManager) ??
    normalizePackageManagerName(evidence.packageJsonPackageManager) ??
    evidence.existingRootLockfileManager
  );
}

export function isMigrationFile(filePath: string): boolean {
  return (
    /(^|\/)migrations\/.*\.sql$/.test(filePath) ||
    filePath.endsWith(".migration.sql") ||
    /^drizzle\.config\./.test(baseName(filePath)) ||
    /^knexfile\./.test(baseName(filePath))
  );
}

function normalizeGuardRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * `frontendRoot` numatytai — legacy `apps/web` konvencija; guard'ai realią reikšmę išsprendžia
 * iš projekto profilio (task 888), kad kitaip pavadintas frontend katalogas (pvz. plikas
 * `frontend/`) irgi būtų klasifikuojamas, o ne tyliai ignoruojamas.
 */
export function isFrontendReactFile(filePath: string, frontendRoot = "apps/web"): boolean {
  if (!/\.(tsx|jsx)$/.test(filePath)) return false;
  return filePath.startsWith(`${normalizeGuardRoot(frontendRoot)}/src/`);
}

/** Ar `eslint-disable` (ar panaši) eilutė turi žmogaus parašytą priežastį. */
export function hasDisableReason(line: string): boolean {
  return /--|because|reason|kod[eė]l|prie[zž]ast/i.test(line);
}

/** `backendRoot` numatytai `apps/api`; motyvas — žr. {@link isFrontendReactFile}. */
export function isBackendApiFile(filePath: string, backendRoot = "apps/api"): boolean {
  const root = normalizeGuardRoot(backendRoot);
  const escapedRoot = escapeRegExpLiteral(root);
  return (
    filePath === `${root}/src/app.ts` ||
    new RegExp(`^${escapedRoot}/src/(routes|controllers|middleware|services|api)/`).test(filePath) ||
    new RegExp(`^${escapedRoot}/src/.*\\.(routes|service|controller)\\.ts$`).test(filePath)
  );
}

/** `mobileRoot` numatytai `apps/mobile`; motyvas — žr. {@link isFrontendReactFile}. */
export function isMobileFile(filePath: string, mobileRoot = "apps/mobile"): boolean {
  const root = normalizeGuardRoot(mobileRoot);
  return new RegExp(`^${escapeRegExpLiteral(root)}/.*\\.(ts|tsx)$`).test(filePath);
}
