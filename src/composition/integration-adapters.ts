// Išorinių integracijų ir benchmark paketo adapteriai (manual DI, LAY-2).
//
// GitHub klientai čia SĄMONINGAI yra „tinklas išjungtas" (etalono `networkDisabledClient` 1:1).
// Etalonas jokio realaus HTTP kliento neturi: politikos vartai, teksto sudarymas ir rezultato
// artefaktas veikia be tinklo, o pats kvietimas paliekamas įpurškiamam klientui. Realaus
// kliento pridėjimas būtų PRAPLEČIANTIS nukrypimas (naujas išorinis paviršius), o migracijos
// kryptis yra griežtinanti — todėl elgesys perkeliamas toks, koks yra.

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
import type { BenchmarkPackagePort } from "../interfaces/cli/benchmark/benchmark-package.js";
import type { BenchmarkCaptureFsPort } from "../application/benchmark/optimization-config.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
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
