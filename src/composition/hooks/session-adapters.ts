// Sesijos ciklo hook'ų portų surišimas (VQ-504 66/N: VQ-502 paliktas wiring'as).
//
// SessionStart, SessionEnd, sesijos santrauka ir UserPromptSubmit. Nė vienas jų neblokuoja —
// jų exit kodas visada 0 — tad adapteris niekur nemeta: gedimas virsta „nežinome" reikšme, o
// sprendimą priima pats hook'as.
//
// Trys dalykai, kurių interfaces sluoksnis pasiimti negali ir kurie čia yra vienintelėje vietoje:
// proceso tapatybė (`parentPid`, `processIsAlive`), TTY būsena ir vaikinio proceso paleidimas
// santraukai.

import path from "node:path";
import { loadAgentPolicy } from "../../application/policy-governance/agent-policy.js";
import { collectChangedFiles } from "../../infrastructure/git/changed-files.js";
import { gitStatusPorcelain, isGitRepository } from "../../infrastructure/git/git-client.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { isProcessAlive } from "../../infrastructure/process/process-tree.js";
import { run } from "../../infrastructure/process/run-process.js";
import { readResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import type { SessionHookFsPort, SessionHookPorts } from "../../interfaces/hooks/session-hook-context.js";
import type { SessionSummaryPorts } from "../../interfaces/hooks/session-summary.js";
import type { UserPromptDeps } from "../../interfaces/hooks/user-prompt.js";
import type { HookIo } from "../../interfaces/hooks/protocol.js";
import { readStdin } from "./adapters.js";
import { policyConfigFs } from "../runtime/node-adapters.js";
import { cliEntryPath, PROJECT_DIR_ENV } from "../runtime/context.js";

/** Sesijos hook'ams reikia platesnio fs porto: katalogų sąrašo, pervadinimo ir mtime. */
const sessionFs: SessionHookFsPort = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  fileMtimeMs: (absolutePath) => nodeFsAdapter.fileMtimeMs(absolutePath),
  removeIfExists: (absolutePath) => nodeFsAdapter.removeIfExists(absolutePath),
  listMarkdownFiles: (absoluteDir) => nodeFsAdapter.listMarkdownFiles(absoluteDir),
  renamePath: (fromPath, toPath) => nodeFsAdapter.renamePath(fromPath, toPath),
};

/**
 * `git status --porcelain` su EXIT KODU, o ne tik tekstu.
 *
 * Kodas čia yra sprendimo dalis: SessionStart iš jo išveda `baseline_valid`. Tuščias tekstas su
 * kodu 0 reiškia švarų medį, o tas pats tuščias tekstas su ne-nuliniu kodu reiškia „git
 * neatsakė" — sulieti juos reikštų, kad nepavykusi patikra atrodo kaip švarus medis.
 */
async function gitStatusWithCode(projectRoot: string): Promise<{ code: number; stdout: string }> {
  const stdout = await gitStatusPorcelain(projectRoot);
  return stdout === undefined ? { code: 1, stdout: "" } : { code: 0, stdout };
}

/**
 * Vaikinio `verqestra` proceso paleidimas. Ta pati forma kaip guard'ų fan-out'e: projekto šaknis
 * keliauja per `CLAUDE_PROJECT_DIR`, o nepaleistas vaikas grąžina non-zero kodą vietoj išimties.
 */
async function runCliChild(command: string, projectRoot: string): Promise<number> {
  const result = await run(process.execPath, [cliEntryPath(), command], {
    cwd: projectRoot,
    env: { ...process.env, [PROJECT_DIR_ENV]: projectRoot },
  }).catch(() => undefined);
  return result?.code ?? 1;
}

/** SessionStart ir SessionEnd portai. */
export function sessionHookPorts(runtimeRoot: string): SessionHookPorts {
  return {
    fs: sessionFs,
    stdin: { readStdin: () => readStdin() },
    // `isTTY` yra `true | undefined`, tad lyginama eksplicitiškai: neapibrėžta reikšmė reiškia
    // NE interaktyvų paleidimą, o būtent tada stdin skaityti privaloma.
    stdinIsInteractive: () => process.stdin.isTTY === true,
    processIsAlive: (pid) => isProcessAlive(pid),
    parentPid: () => process.ppid,
    env: (name) => process.env[name],
    gitStatusPorcelain: (projectRoot) => gitStatusWithCode(projectRoot),
    // Portas kalba `stateDir` kalba, o saugykla — runtime šaknies; `dirname` yra vertimas tarp
    // jų, o ne spėjimas: `stateDir` pagal apibrėžimą yra `<runtimeRoot>/state`.
    readDispatchCheckpoint: (stateDir) => readResumeCheckpoint(path.dirname(stateDir), "claude"),
    collectChangedFiles: (projectRoot) => collectChangedFiles(projectRoot, runtimeRoot),
    runSessionSummary: (projectRoot) => runCliChild("hook-session-summary", projectRoot),
  };
}

/** Sesijos santraukos portai. */
export function sessionSummaryPorts(runtimeRoot: string): SessionSummaryPorts {
  return {
    fs: {
      exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
      readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
      writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
      appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
      makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
      fileSizeBytes: (absolutePath) => nodeFsAdapter.fileSizeBytes(absolutePath),
    },
    collectChangedFiles: (projectRoot) => collectChangedFiles(projectRoot, runtimeRoot),
    isGitRepository: (projectRoot) => isGitRepository(projectRoot),
    // Santraukai kodas nesvarbus: ji skiria „git neprieinamas" per `isGitRepository`, o čia jai
    // reikia tik teksto, ir nepavykęs skaitymas teisingai krenta į sesijos nuotraukos šaką.
    gitStatusText: async (projectRoot) => (await gitStatusPorcelain(projectRoot)) ?? "",
  };
}

/**
 * Agentų santrauka `UserPromptSubmit` konteksto blokui — ĮJUNGTI `vq/config/agents.json` vaidmenys.
 *
 * Modulis turi savo numatytąjį sąrašą, bet jis yra šios repozitorijos agentų kopija; realiame
 * target projekte jis meluotų. Todėl kompozicija paduoda tikrą registrą, o numatytasis lieka tik
 * tam atvejui, kai registro nėra — tada geriau bendras sąrašas nei tuščia eilutė.
 */
async function agentSummary(runtimeRoot: string): Promise<string | undefined> {
  try {
    const policy = await loadAgentPolicy(policyConfigFs, runtimeRoot);
    const names = Object.entries(policy.roles)
      .filter(([, role]) => role.enabled !== false)
      .map(([name]) => name);
    return names.length > 0 ? names.join(", ") : undefined;
  } catch {
    return undefined;
  }
}

/** `UserPromptSubmit` deps: modulis portų objekto neima, tad surišama tiesiai. */
export async function userPromptDeps(runtimeRoot: string, io?: HookIo): Promise<UserPromptDeps> {
  const summary = await agentSummary(runtimeRoot);
  return {
    fs: {
      exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
      readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
      writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
      appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
      makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
    },
    runtimeRoot,
    ...(summary === undefined ? {} : { agentSummary: summary }),
    ...(io === undefined ? {} : { io }),
  };
}
