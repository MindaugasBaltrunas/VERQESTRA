// Reali failų sistemos detekcija projekto profiliui (task 888): įrodymus renkantis
// adapteris, kviečiantis gryną `domain/project/profile.ts` `resolveProjectProfile`.
// Elgesio etalonas: AG_loop application/project-bootstrap/detect-profile.ts. VERQESTRA
// skirtumai: marker/source skenas ateina per ProfileDetectionPorts (etalono
// runtime/project-mode.ts skenas — E4 adapterio darbas).

import path from "node:path";
import {
  resolveProjectProfile,
  type ExplicitProfileChoices,
  type InputEvidence,
  type ProjectProfile,
} from "../../domain/project/index.js";

// Re-eksportas application sluoksnio vardu, kad `interfaces/**` kvietėjai priklausytų nuo
// šio modulio kontrakto, o ne siektų pro jį tiesiai į domain/project.
export type DetectedProjectProfile = ProjectProfile;

export type ProfileDetectionPorts = {
  exists(absolutePath: string): Promise<boolean>;
  /** Produkto marker failų vardai projekto šaknyje (package.json, go.mod, ...). */
  findProductMarkers(projectRoot: string): Promise<string[]>;
  /** Ribotas source failų skenas (bounded/best-effort — čia advisory seeding, ne indeksas). */
  findSourceFiles(projectRoot: string, limit: number): Promise<string[]>;
};

// Tvarka pagal specifiškumą: projektas gali turėti kelis marker failus (pvz. Node įrankis
// šiaip Python repo viduje), tad laimi pirmas užtikrintas match'as, ne paskutinis.
const LANGUAGE_BY_EXTENSION: Array<[string, string]> = [
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".go", "go"],
  [".py", "python"],
  [".php", "php"],
  [".cs", "csharp"],
  [".csproj", "csharp"],
  [".sln", "csharp"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
];

/** Dominuojanti kalba iš skenuotų source failų plėtinių; `undefined` be įrodymų. */
function detectLanguage(sourceFiles: string[]): string | undefined {
  const extensionCounts = new Map<string, number>();
  for (const file of sourceFiles) {
    const ext = path.extname(file).toLowerCase();
    extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [ext, language] of LANGUAGE_BY_EXTENSION) {
    const count = extensionCounts.get(ext) ?? 0;
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}

// Šakninių lockfile įrodymų tvarka; laimi pirmas rastas diske.
const PACKAGE_MANAGER_LOCKFILES: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
  ["requirements.txt", "pip"],
  ["composer.lock", "composer"],
  ["go.sum", "go modules"],
  ["go.mod", "go modules"],
];

async function detectPackageManager(ports: ProfileDetectionPorts, projectRoot: string): Promise<string | undefined> {
  for (const [lockfile, manager] of PACKAGE_MANAGER_LOCKFILES) {
    if (await ports.exists(path.join(projectRoot, lockfile))) return manager;
  }
  return undefined;
}

// Katalogo vardų kandidatai source-root įrodymams: guard-roots (task 888) žinomos
// frontend/backend/mobile formos + įprastos konvencijos.
const SOURCE_ROOT_CANDIDATES = [
  "apps",
  "modules",
  "packages",
  "workers",
  "internal",
  "cmd",
  "lib",
  "pkg",
  "app",
  "services",
  "src",
  "frontend",
  "backend",
  "mobile",
  "client",
  "server",
];

async function detectSourceRoots(ports: ProfileDetectionPorts, projectRoot: string): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of SOURCE_ROOT_CANDIDATES) {
    if (await ports.exists(path.join(projectRoot, candidate))) roots.push(candidate);
  }
  if (await ports.exists(path.join(projectRoot, "AG", "orchestrator", "src"))) {
    roots.push("AG/orchestrator/src");
  }
  return roots;
}

/**
 * Surenka realius workspace įrodymus {@link resolveProjectProfile}'ui: kalbą (dominuojantis
 * source plėtinys), package manager'į (šakninis lockfile) ir source roots (diske realiai
 * esančios žinomos katalogų konvencijos).
 */
export async function detectProjectProfileEvidence(
  ports: ProfileDetectionPorts,
  projectRoot: string,
): Promise<InputEvidence> {
  const root = path.resolve(projectRoot);
  const [markers, sourceFiles, sourceRoots, packageManager] = await Promise.all([
    ports.findProductMarkers(root),
    ports.findSourceFiles(root, 200),
    detectSourceRoots(ports, root),
    detectPackageManager(ports, root),
  ]);
  const language = detectLanguage(sourceFiles) ?? languageFromMarkersOnly(markers);
  return {
    sourceRoots,
    forbiddenPaths: [],
    ...(language === undefined ? {} : { language }),
    ...(packageManager === undefined ? {} : { packageManager }),
  };
}

// Projektas su produkto marker'iais, bet dar be skenuotų source failų (pvz. tik manifestas)
// vis tiek gauna kalbos užuominą iš paties marker'io.
function languageFromMarkersOnly(markers: string[]): string | undefined {
  if (markers.includes("go.mod") || markers.includes("go.sum")) return "go";
  if (
    markers.includes("pyproject.toml") ||
    markers.includes("requirements.txt") ||
    markers.includes("Pipfile") ||
    markers.includes("poetry.lock")
  ) {
    return "python";
  }
  if (markers.includes("composer.json") || markers.includes("composer.lock")) return "php";
  if (markers.includes("global.json") || markers.includes("Directory.Build.props")) return "csharp";
  if (markers.some((marker) => /^package(-lock)?\.json$|^yarn\.lock$|^pnpm-workspace\.yaml$/.test(marker))) {
    return "typescript";
  }
  return undefined;
}

/**
 * Aptinka realų projekto profilį iš disko ir išsprendžia jį per gryną
 * {@link resolveProjectProfile}. `explicit` leidžia kvietėjui (pvz. jau persist'intam
 * profile.json) perrašyti atskirus aptiktus laukus.
 */
export async function detectProjectProfile(
  ports: ProfileDetectionPorts,
  projectRoot: string,
  explicit: ExplicitProfileChoices = {},
): Promise<ProjectProfile> {
  const evidence = await detectProjectProfileEvidence(ports, projectRoot);
  return resolveProjectProfile(evidence, explicit);
}
