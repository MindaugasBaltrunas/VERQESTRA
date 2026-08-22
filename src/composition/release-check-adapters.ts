// `build-gate`, `milestone-check` ir `release-check` adapteriai (manual DI, LAY-2).
//
// Atskiras failas nuo `readiness-adapters.ts` dėl temos, ne tik dydžio: šie trys VYKDO projekto
// komandas (`pnpm build`, `pnpm test`) ir sudeda kelių posistemių verdiktus į vieną. Auditų
// klasteris, priešingai, tik skaito. Sumaišius juos, „skaitantis auditas" nebeliktų skaitantis.

import path from "node:path";
import { runQualityGates } from "../application/quality-gates/quality-gates.js";
import type { QualityGatesStatus } from "../application/quality-gates/quality-gates-status.js";
import { securityVerify } from "../application/quality-gates/security-verify.js";
import { specDrift } from "../application/quality-gates/spec-drift.js";
import type { BuildGatePorts } from "../application/release-readiness/build-gate.js";
import {
  milestoneCheckResultPath,
  runMilestoneCheck,
  type MilestoneCheckPorts,
  type MilestoneCheckResult,
  type MilestoneCheckRunners,
} from "../application/release-readiness/milestone-check.js";
import {
  findBrokenReadmeLinks,
  releaseCheckResultPath,
  type ReleaseCheckFsPort,
  type ReleaseCheckPart,
  type ReleaseCheckPorts,
  type ReleaseCheckResult,
  type ReleaseCheckRunners,
  type SourceStateInputs,
} from "../application/release-readiness/release-check.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { findStaleDistFiles } from "../infrastructure/process/dist-freshness.js";
import { packageManagerExecutable, run } from "../infrastructure/process/run-process.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { qualityGatesPorts } from "./quality-adapters.js";
import { securityVerifyPorts } from "./readiness-adapters.js";
import { specDriftPorts } from "./node-adapters.js";

/** Kiek komandos išvesties patenka į verdiktą: pilnas build log'as verdikto failo neinformuoja. */
const MAX_ISSUE_CHARS = 500;

/** `build-gate`: viena operacija — pasenusių artefaktų sąrašas. */
export const buildGatePorts: BuildGatePorts = {
  findStaleDistFiles: (packageRoot) => findStaleDistFiles(packageRoot),
};

/**
 * Source-state hash'o įėjimai VERQESTRA formai.
 *
 * Skirtumas nuo etalono yra tik keliai: vienas paketas šaknyje vietoj `AG/orchestrator`, o
 * `ui-app`/`benchmark` darbo sritys prisijungs kartu su E6 paketais. Sąrašas SĄMONINGAI vardija
 * įėjimus po vieną: `**` šablonas įtrauktų ir `dist`, ir `node_modules`, ir hash'as keistųsi nuo
 * kiekvieno build'o — tada jis nebematuotų šaltinio.
 */
export const RELEASE_SOURCE_STATE_INPUTS: SourceStateInputs = {
  dirs: ["src", "scripts"],
  files: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "README.md", "CLAUDE.md"],
};

const releaseCheckFs: ReleaseCheckFsPort = {
  listFilesRecursive: (absoluteDir) => nodeFsAdapter.listFilesRecursive(absoluteDir),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/**
 * Aktyvus spec change: pirmas (abėcėlės tvarka) `AG/spec/changes/<id>/spec.json` su
 * `status: "active"`.
 *
 * Nesantis katalogas grąžina `undefined` — projektas be spec change'ų nėra gedimas. Sugadintas
 * `spec.json` PRALEIDŽIAMAS, o ne meta: milestone patikra neturi kristi dėl vieno svetimo
 * artefakto, o realus scope vartas yra `spec-drift`, kuris tokį failą atmeta garsiai.
 */
async function findActiveSpecChangeId(projectRoot: string): Promise<string | undefined> {
  const changesRoot = path.join(projectRoot, "AG", "spec", "changes");
  const entries = await nodeFsAdapter.listSubdirectories(changesRoot);
  for (const entry of [...entries].sort((a, b) => a.localeCompare(b))) {
    const raw = await nodeFsAdapter.readTextFileIfExists(path.join(changesRoot, entry, "spec.json"));
    if (raw === undefined) continue;
    const parsed = tryParseJson<{ id?: string; status?: string }>(raw);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") continue;
    if (parsed.value.status === "active") return parsed.value.id?.trim() || entry;
  }
  return undefined;
}

export function milestoneCheckPorts(projectRoot: string, runtimeRoot: string): MilestoneCheckPorts {
  return {
    activeChangeId: () => findActiveSpecChangeId(projectRoot),
    writeResult: (result: MilestoneCheckResult) =>
      nodeFsAdapter.writeTextFileAtomic(milestoneCheckResultPath(runtimeRoot), toPrettyJson(result)),
  };
}

export function milestoneCheckRunners(projectRoot: string, runtimeRoot: string): MilestoneCheckRunners {
  return {
    quality: () =>
      runQualityGates(qualityGatesPorts(runtimeRoot, projectRoot), ["--scope", "milestone"], { projectRoot }),
    specAlignment: (changeId) => specDrift(specDriftPorts(projectRoot, runtimeRoot), [changeId], projectRoot),
    localPolicy: (files) => securityVerify(securityVerifyPorts(projectRoot, runtimeRoot), files, projectRoot),
  };
}

export function releaseCheckPorts(runtimeRoot: string): ReleaseCheckPorts {
  return {
    fs: releaseCheckFs,
    writeResult: (result: ReleaseCheckResult) =>
      nodeFsAdapter.writeTextFileAtomic(releaseCheckResultPath(runtimeRoot), toPrettyJson(result)),
  };
}

/** Vienas paketų tvarkyklės paleidimas: `run` pats parenka `cmd.exe` kelią `.cmd` shim'ams. */
async function runPnpm(args: string[], projectRoot: string): Promise<{ exitCode: number; issues: string[] }> {
  const result = await run(packageManagerExecutable("pnpm"), args, { cwd: projectRoot });
  if (result.code === 0) return { exitCode: 0, issues: [] };
  const detail = (result.stderr || result.stdout || `pnpm ${args.join(" ")} failed`).trim();
  return { exitCode: result.code, issues: [detail.slice(0, MAX_ISSUE_CHARS)] };
}

/**
 * Paketo layout vartas.
 *
 * Tikrinama tai, ką paketas JAU deklaruoja: įėjimo taškas, bin vardas ir sugeneruotas CLI. `files`
 * laukas ir E6 darbo sričių artefaktai (`ui-app/dist`) į šį sąrašą ateina kartu su pačiais
 * paketais — vartas, reikalaujantis to, ko produktas dar neturi, praneša ne apie gedimą, o apie
 * neužbaigtą migraciją, ir tam yra `readiness-audit`.
 */
async function verifyPackageLayout(projectRoot: string): Promise<ReleaseCheckPart> {
  const issues: string[] = [];
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(projectRoot, "package.json"));
  if (raw === undefined) return { status: "failed", issues: ["package.json is missing"] };
  const parsed = tryParseJson<{ main?: string; bin?: Record<string, string> }>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return { status: "failed", issues: ["package.json is not valid JSON"] };
  }

  const pkg = parsed.value;
  if (pkg.main !== "./dist/cli.js") issues.push("package main must be ./dist/cli.js");
  if (pkg.bin?.["verqestra"] !== "./dist/cli.js") issues.push("package bin.verqestra must be ./dist/cli.js");
  for (const relativePath of ["dist/cli.js", "src/cli.ts"]) {
    if (!(await nodeFsAdapter.exists(path.join(projectRoot, relativePath)))) {
      issues.push(`package layout path is missing: ${relativePath}`);
    }
  }
  return { status: issues.length === 0 ? "ok" : "failed", issues };
}

/** README nuorodų integralumas — vienintelis dokumentacijos vartas, kurį galima patikrinti mašina. */
async function verifyReleaseDocs(projectRoot: string): Promise<ReleaseCheckPart> {
  const broken = await findBrokenReadmeLinks(releaseCheckFs, projectRoot);
  return {
    status: broken.length === 0 ? "ok" : "failed",
    issues: broken.map((link) => `README link is broken: ${link}`),
  };
}

export function releaseCheckRunners(projectRoot: string, runtimeRoot: string): ReleaseCheckRunners {
  return {
    build: async () => ({ command: "pnpm build", ...(await runPnpm(["build"], projectRoot)) }),
    tests: async () => ({ command: "pnpm test:only", ...(await runPnpm(["test:only"], projectRoot)) }),
    milestone: (quality: QualityGatesStatus) =>
      runMilestoneWithQuality(projectRoot, runtimeRoot, quality),
    docs: () => verifyReleaseDocs(projectRoot),
    packageLayout: () => verifyPackageLayout(projectRoot),
  };
}

/**
 * Milestone patikra release kelyje NEPALEIDŽIA kokybės vartų iš naujo: `release-check` ką tik
 * pastatė ir ištestavo medį, ir tas rezultatas jau YRA kokybės verdiktas. Antras paleidimas
 * kainuotų visą build'ą dar kartą ir galėtų duoti kitą atsakymą tam pačiam medžiui.
 */
function runMilestoneWithQuality(
  projectRoot: string,
  runtimeRoot: string,
  quality: QualityGatesStatus,
): Promise<MilestoneCheckResult> {
  return runMilestoneCheck(milestoneCheckPorts(projectRoot, runtimeRoot), {
    ...milestoneCheckRunners(projectRoot, runtimeRoot),
    quality: () => Promise.resolve(quality),
  });
}
