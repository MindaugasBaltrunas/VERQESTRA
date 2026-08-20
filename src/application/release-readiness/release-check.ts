// release-readiness use case (etalono release-check.ts, WBR VQ-305): build/tests/milestone/
// docs/package-layout patikros + source-state hash'as, kurį final-audit naudoja release-check
// šviežumui. Rezultatas persistuojamas per portą (`vq/state/release-check-result.json`).
//
// Etalono default runner'iai (pnpm spawn, AG_loop-specifinis docs sąrašas ir npm paketo
// layout'as) yra REPO POLITIKA, ne bendra taisyklė — VERQESTRA jų neneša: visus penkis
// runner'ius paduoda composition (E5). Čia lieka kompozicijos seka, source-state hash'as su
// PARAMETRIZUOTAIS įėjimais ir README nuorodų integralumo taisyklė.
import { createHash } from "node:crypto";
import path from "node:path";
import { toPosixPath } from "../../shared/paths.js";
import { extractRelativeMarkdownLinks } from "../../shared/markdown.js";
import type { MilestoneCheckResult } from "./milestone-check.js";
import type { QualityGatesStatus } from "../quality-gates/quality-gates-status.js";

export type ReleaseCheckStatus = "ok" | "failed";
export type ReleaseCheckPartStatus = "ok" | "failed";

export type ReleaseCheckPart = {
  status: ReleaseCheckPartStatus;
  issues: string[];
};

export type ReleaseCheckCommandPart = ReleaseCheckPart & {
  command: string;
  exitCode: number;
};

export type ReleaseCheckMilestonePart = ReleaseCheckPart & {
  result?: MilestoneCheckResult;
};

export type ReleaseCheckSourceState = {
  hash: string;
  file_count: number;
};

export type ReleaseCheckResult = {
  status: ReleaseCheckStatus;
  build: ReleaseCheckCommandPart;
  tests: ReleaseCheckCommandPart;
  milestone: ReleaseCheckMilestonePart;
  docs: ReleaseCheckPart;
  package_layout: ReleaseCheckPart;
  failed_parts: string[];
  result_path: string;
  updated_at: string;
  source_state: ReleaseCheckSourceState;
};

export type ReleaseCheckRunners = {
  build: () => Promise<{ command: string; exitCode: number; issues?: string[] }>;
  tests: () => Promise<{ command: string; exitCode: number; issues?: string[] }>;
  milestone: (quality: QualityGatesStatus) => Promise<MilestoneCheckResult>;
  docs: () => Promise<ReleaseCheckPart>;
  packageLayout: () => Promise<ReleaseCheckPart>;
};

/** FS skaitymo portas source-state hash'ui ir README nuorodų patikrai (adapteris — E4). */
export type ReleaseCheckFsPort = {
  /** Rekursinis failų sąrašas ABSOLIUČIAIS keliais; katalogo nebuvimas — tuščias sąrašas. */
  listFilesRecursive(absoluteDir: string): Promise<string[]>;
  exists(absolutePath: string): Promise<boolean>;
  /** Failo turinys; meta, kai failo nėra (source-state įėjimai jau atfiltruoti per exists). */
  readTextFile(absolutePath: string): Promise<string>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export type ReleaseCheckPorts = {
  fs: ReleaseCheckFsPort;
  writeResult(result: ReleaseCheckResult): Promise<void>;
};

export type RunReleaseCheckOptions = {
  projectRoot?: string;
  now?: Date;
  sourceStateInputs?: SourceStateInputs;
};

/** `vq/state/release-check-result.json` — verdikto failas (rašo adapteris). */
export function releaseCheckResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "release-check-result.json");
}

/** Source-state hash'o įėjimai — katalogai ir pavieniai failai projekto šaknies atžvilgiu. */
export type SourceStateInputs = {
  dirs: string[];
  files: string[];
};

/**
 * VERQESTRA numatytieji įėjimai (etalone sąrašas dengė AG/orchestrator + ui-app layout'ą —
 * VERQESTRA yra vieno paketo repo su `src/`): visas produkto šaltinis + manifestai, nuo
 * kurių priklauso build'as. Papildomus kelius composition paduoda per options.
 */
export const DEFAULT_SOURCE_STATE_INPUTS: SourceStateInputs = {
  dirs: ["src", "scripts", "templates"],
  files: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "README.md"],
};

export async function computeSourceState(
  fs: ReleaseCheckFsPort,
  projectRoot: string,
  inputs: SourceStateInputs = DEFAULT_SOURCE_STATE_INPUTS,
): Promise<ReleaseCheckSourceState> {
  const root = path.resolve(projectRoot);
  const collected = await Promise.all(
    inputs.dirs.map(async (relativeDir) => {
      const absolute = await fs.listFilesRecursive(path.join(root, relativeDir));
      return absolute.map((file) => path.relative(root, file));
    }),
  );
  const presentFiles = (
    await Promise.all(
      inputs.files.map(async (relativePath) => ((await fs.exists(path.join(root, relativePath))) ? relativePath : undefined)),
    )
  ).filter((value): value is string => value !== undefined);
  const relativePaths = [...new Set([...collected.flat(), ...presentFiles])].map(toPosixPath).sort();

  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    const content = await fs.readTextFile(path.join(root, relativePath));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content, "utf8");
    hash.update("\0");
  }

  return { hash: hash.digest("hex"), file_count: relativePaths.length };
}

export async function runReleaseCheck(
  ports: ReleaseCheckPorts,
  runners: ReleaseCheckRunners,
  options: RunReleaseCheckOptions = {},
): Promise<ReleaseCheckResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  const buildResult = await runners.build();
  const testsResult = await runners.tests();
  const milestoneResult = await runners.milestone(
    releaseQualityResult(buildResult, testsResult, [buildResult.command, testsResult.command], options.now),
  );
  const docsResult = await runners.docs();
  const packageLayoutResult = await runners.packageLayout();
  const sourceState = await computeSourceState(ports.fs, projectRoot, options.sourceStateInputs);

  const build = commandPart(buildResult);
  const tests = commandPart(testsResult);
  const milestone: ReleaseCheckMilestonePart = {
    status: milestoneResult.status === "ok" ? "ok" : "failed",
    issues: milestoneResult.status === "ok" ? [] : ["milestone check failed: " + milestoneResult.failed_parts.join(", ")],
    result: milestoneResult,
  };

  const parts = {
    build: build.status,
    tests: tests.status,
    milestone: milestone.status,
    docs: docsResult.status,
    package_layout: packageLayoutResult.status,
  };
  const failedParts = Object.entries(parts)
    .filter(([, status]) => status !== "ok")
    .map(([name]) => name);
  const result: ReleaseCheckResult = {
    status: failedParts.length === 0 ? "ok" : "failed",
    build,
    tests,
    milestone,
    docs: docsResult,
    package_layout: packageLayoutResult,
    failed_parts: failedParts,
    result_path: "vq/state/release-check-result.json",
    updated_at: (options.now ?? new Date()).toISOString(),
    source_state: sourceState,
  };

  await ports.writeResult(result);
  return result;
}

/**
 * Root README nuorodų integralumo vartas (etalono spec 876): README yra pirmasis
 * autoritetas, kurį skaito agentai, tad kiekviena jo reklamuojama santykinė nuoroda privalo
 * vesti į realų failą. Sulaužytos nuorodos numuša release-check `docs` dalį.
 */
export async function findBrokenReadmeLinks(fs: ReleaseCheckFsPort, projectRoot: string): Promise<string[]> {
  const readmePath = path.join(projectRoot, "README.md");
  const markdown = await fs.readTextFileIfExists(readmePath);
  if (markdown === undefined || !markdown.trim()) return ["required doc is missing or empty: README.md"];

  const issues: string[] = [];
  for (const target of extractRelativeMarkdownLinks(markdown)) {
    const resolved = path.resolve(projectRoot, target);
    if (!(await fs.exists(resolved))) {
      issues.push("README.md links to a missing path: " + target);
    }
  }
  return issues;
}

function commandPart(result: { command: string; exitCode: number; issues?: string[] }): ReleaseCheckCommandPart {
  return {
    command: result.command,
    exitCode: result.exitCode,
    status: result.exitCode === 0 && (result.issues?.length ?? 0) === 0 ? "ok" : "failed",
    issues: result.issues ?? [],
  };
}

function releaseQualityResult(
  build: { exitCode: number },
  tests: { exitCode: number },
  commands: string[],
  now = new Date(),
): QualityGatesStatus {
  const passed = build.exitCode === 0 && tests.exitCode === 0;
  return {
    passed,
    exit_code: passed ? 0 : 1,
    has_commands: true,
    scope: "milestone",
    commands,
    skipped: [],
    failed_gates: [build.exitCode === 0 ? undefined : "build", tests.exitCode === 0 ? undefined : "tests"].filter(
      (gate): gate is string => gate !== undefined,
    ),
    results: [],
    updated_at: now.toISOString(),
  };
}
