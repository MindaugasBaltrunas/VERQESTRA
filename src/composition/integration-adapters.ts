// Išorinių integracijų ir benchmark paketo adapteriai (manual DI, LAY-2).
//
// GitHub klientai čia SĄMONINGAI yra „tinklas išjungtas" (etalono `networkDisabledClient` 1:1).
// Etalonas jokio realaus HTTP kliento neturi: politikos vartai, teksto sudarymas ir rezultato
// artefaktas veikia be tinklo, o pats kvietimas paliekamas įpurškiamam klientui. Realaus
// kliento pridėjimas būtų PRAPLEČIANTIS nukrypimas (naujas išorinis paviršius), o migracijos
// kryptis yra griežtinanti — todėl elgesys perkeliamas toks, koks yra.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getImportableGitHubIssue,
  normalizeGitHubIssueImportPolicy,
  renderIssueDraftTask,
  type GitHubIssueClient,
} from "../infrastructure/integrations/github-issues.js";
import {
  createGitHubPullRequest,
  normalizeGitHubPrPolicy,
  type GitHubPrClient,
} from "../infrastructure/integrations/github-pr.js";
import type { GitHubIssueImportPorts } from "../interfaces/cli/github/issue-import.js";
import type { GitHubPrPorts } from "../interfaces/cli/github/pull-request.js";
import type { BenchmarkDrivePorts, BenchmarkDriveRunResult } from "../interfaces/cli/benchmark/benchmark-drive.js";
import type { LoopCellPorts } from "../interfaces/cli/benchmark/benchmark-loop-cell.js";
import type { CellUsageRecord } from "../interfaces/cli/benchmark/benchmark-cell.js";
import type { BenchmarkPackagePort } from "../interfaces/cli/benchmark/benchmark-package.js";
import type { BenchmarkCaptureFsPort } from "../application/benchmark/optimization-config.js";
import { extractUsage, isUsageLimitOutput } from "../infrastructure/adapters/claude-usage.js";
import { runClaudeHeadless } from "../infrastructure/adapters/claude-headless.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { readStdin } from "./hook-adapters.js";
import { run } from "../infrastructure/process/run-process.js";
import { cliEntryPath, PROJECT_DIR_ENV } from "./runtime-context.js";
import { tryParseJson } from "../shared/json.js";
import { policyConfigFs } from "./node-adapters.js";

/**
 * Tinklo neturintis issue klientas. Meta AIŠKIĄ žinutę, o ne grąžina tuščią rezultatą:
 * tylus „nieko neradau" būtų neatskiriamas nuo realiai neegzistuojančio issue.
 */
const networkDisabledIssueClient: GitHubIssueClient = {
  getIssue: () =>
    Promise.reject(new Error("No GitHub issue client configured. Inject a GitHubIssueClient to import issues.")),
};

const networkDisabledPrClient: GitHubPrClient = {
  createPullRequest: () =>
    Promise.reject(new Error("No GitHub client configured. Inject a GitHubPrClient to create pull requests.")),
};

/** `github-issue-import`: politika, vartai ir draft renderis. */
export const gitHubIssueImportPorts: GitHubIssueImportPorts = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  // Normalizacija gyvena integracijos modulyje: dalinis (`Partial`) konfigas virsta pilna
  // politika ten pat, kur ir vartai, kad CLI pusė nespėliotų default'ų.
  importIssue: (input) =>
    getImportableGitHubIssue(
      { policy: normalizeGitHubIssueImportPolicy(input.policy), issueNumber: input.issueNumber },
      networkDisabledIssueClient,
    ),
  renderIssueDraftTask: (issue) => renderIssueDraftTask(issue),
};

/** `github-pr`: politika, vartai ir PR kūrimas (tinklas išjungtas). */
export const gitHubPrPorts: GitHubPrPorts = {
  policyFs: policyConfigFs,
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  createPullRequest: (input) =>
    createGitHubPullRequest(
      { policy: normalizeGitHubPrPolicy(input.policy), title: input.title, body: input.body },
      networkDisabledPrClient,
    ),
};

/**
 * `benchmark` paketo krautuvas: egzistavimo patikra plius dinaminis ESM importas.
 *
 * Kelias verčiamas `file://` URL: win32 `import("D:/...")` krenta su
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`, nes disko raidė atrodo kaip protokolas.
 */
export const benchmarkPackageLoader: BenchmarkPackagePort = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  load: (absolutePath) => import(new URL(`file://${path.resolve(absolutePath).split(path.sep).join("/")}`).href),
};

/** `optimization-benchmark`: konfigo, baseline ir raportų failai. */
export const benchmarkCaptureFs: BenchmarkCaptureFsPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/**
 * Vienas ribotas headless `claude` kvietimas benchmark scenarijui.
 *
 * Trys dalykai, kurių use case'as daryti negali ir dėl kurių jie gyvena BŪTENT čia:
 *
 * 1. Laikinas state katalogas kuriamas UŽ `--workdir` ribų. Ten `runClaudeHeadless` win32
 *    šakoje rašo savo prompt'o tmp failą; scenarijaus kataloge jis atsidurtų checkout'o
 *    diff'e ir būtų neatskiriamas nuo paties agento darbo.
 * 2. `runClaudeHeadless` paleidžia `claude` ties `process.cwd()` ir cwd parametro neturi,
 *    todėl vienintelis būdas nukreipti agentą į `--workdir` yra laikinas `process.chdir`,
 *    grąžinamas `finally` bloke NEPRIKLAUSOMAI nuo baigties.
 * 3. Timeout'as tam pačiam kvietimui perduodamas per `CLAUDE_HEADLESS_TIMEOUT_MS` ir
 *    atstatomas — kitaip vienas benchmark bėgimas tyliai perrašytų viso proceso nustatymą.
 */
async function runBenchmarkHeadless(input: {
  prompt: string;
  model: string;
  cwd: string;
  timeoutMs: number;
  maxTurns: number;
  permissionMode: "auto" | "acceptEdits";
}): Promise<BenchmarkDriveRunResult> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "vq-benchmark-drive-"));
  const previousCwd = process.cwd();
  const previousTimeout = process.env["CLAUDE_HEADLESS_TIMEOUT_MS"];

  try {
    process.chdir(input.cwd);
    process.env["CLAUDE_HEADLESS_TIMEOUT_MS"] = String(input.timeoutMs);
    return await runClaudeHeadless(input.prompt, input.model, runtimeDir, {
      maxTurns: input.maxTurns,
      permissionMode: input.permissionMode,
    });
  } finally {
    process.chdir(previousCwd);
    if (previousTimeout === undefined) delete process.env["CLAUDE_HEADLESS_TIMEOUT_MS"];
    else process.env["CLAUDE_HEADLESS_TIMEOUT_MS"] = previousTimeout;
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

/** `benchmark-drive`: katalogo patikra, prompt'as, vienas headless kvietimas ir usage skaitymas. */
export const benchmarkDrivePorts: BenchmarkDrivePorts = {
  isDirectory: async (absolutePath) => (await nodeFsAdapter.statKind(absolutePath)) === "directory",
  readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
  readStdin: () => readStdin(),
  runHeadless: (input) => runBenchmarkHeadless(input),
  isUsageLimitOutput: (stdout) => isUsageLimitOutput(stdout),
  extractUsage: (stdout) => extractUsage(stdout),
};

/**
 * `benchmark-loop-cell` portai: pilnas eilės ciklas scenarijaus kopijoje.
 *
 * Ciklas paleidžiamas ATSKIRU procesu su `CLAUDE_PROJECT_DIR`, nukreiptu į kopiją, o ne per
 * `process.chdir`: `process-queued-task` pats spawn'ina vaikus ir skaito runtime šaknį iš
 * aplinkos, tad viso proceso cwd keitimas čia nuskintų ne tą medį — ir tai matytųsi tik tada,
 * kai dvi celės sutaptų laike.
 */
export const benchmarkLoopCellPorts: LoopCellPorts = {
  isDirectory: async (absolutePath) => (await nodeFsAdapter.statKind(absolutePath)) === "directory",
  readStdin: () => readStdin(),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  runCycle: async (input) => {
    const result = await run(
      process.execPath,
      [cliEntryPath(), "process-queued-task", input.taskFile],
      {
        cwd: input.workdir,
        timeoutMs: input.timeoutMs,
        env: {
          ...process.env,
          [PROJECT_DIR_ENV]: input.workdir,
          CLAUDE_HEADLESS_TIMEOUT_MS: String(input.timeoutMs),
          // Celės modelis ir turn lubos keliauja per aplinką: kopijoje nėra nei models.env, nei
          // turn politikos, o įrašius juos į jos konfigą, jie taptų matuojamo medžio dalimi.
          CLAUDE_SONNET_MODEL: input.model,
          CLAUDE_OPUS_MODEL: input.model,
          CLAUDE_HAIKU_MODEL: input.model,
          AG_MAX_TURNS: String(input.stepLimit),
        },
      },
    ).catch((error: unknown) => ({
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  },
  readUsageRecords: async (workdir) => {
    const raw = await nodeFsAdapter.readTextFileIfExists(
      path.join(workdir, "vq", "logs", "token-usage.jsonl"),
    );
    if (raw === undefined) return [];
    const records: CellUsageRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = tryParseJson<CellUsageRecord>(line);
      // Sugadinta eilutė praleidžiama, bet TYLIAI: žurnalas yra append-only, ir viena nutrūkusi
      // eilutė neturi paversti viso ciklo neišmatuotu. Trūkstamas kvietimas matysis `captured`
      // vėliavoje, kurią ciklas rašo pats.
      if (parsed.ok && parsed.value !== null && typeof parsed.value === "object") records.push(parsed.value);
    }
    return records;
  },
  humanReviewCount: async (workdir) =>
    (await nodeFsAdapter.listMarkdownFiles(path.join(workdir, "AG", "tasks", "human-review"))).length,
  isUsageLimitOutput: (stdout) => isUsageLimitOutput(stdout),
};
