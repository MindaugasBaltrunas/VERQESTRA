// Stop hook'o portai (manual DI, LAY-2).
//
// `hookOnStop` yra didžiausias visos hook'ų šeimos vartas: jis nusprendžia, ar sesijos darbas
// keliauja į commit'ą ir push'ą. VQ-504 jį perkėlė ir ištestavo (317 eilučių + savo suite'as),
// bet PALIKO BE CLI ĮĖJIMO — vartas egzistavo tik testuose. Tai ta pati „pastatyta, ištestuota,
// neprijungta" klasė, kurią 64/N–66/N uždarė kitiems hook'ams; čia ji uždaroma paskutiniam.
//
// Atskiras failas nuo `guard-hook-adapters`: tas rinkinys yra SKAITANTIS (guard'ai tik praneša),
// o šis RAŠO į git istoriją. Sumaišius, git rašymo priklausomybė atsirastų kiekviename guard'e.

import type { StopHookPorts } from "../../interfaces/hooks/on-stop-context.js";
import type { HookFsPort } from "../../interfaces/hooks/protocol.js";
import { loadGitAutomationPolicy } from "../../application/policy-governance/git-automation-policy.js";
import { qualityGatesStatusPath, type QualityGatesStatus } from "../../application/quality-gates/quality-gates-status.js";
import { collectChangedFiles } from "../../infrastructure/git/changed-files.js";
import { commitAndPush } from "../../infrastructure/git/git-automation.js";
import {
  filterGitIgnored,
  gitStatusPorcelain,
  isGitRepository,
} from "../../infrastructure/git/git-client.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { commandExists, run, runShell } from "../../infrastructure/process/run-process.js";
import { stopBridgeForProject } from "../../infrastructure/state/stop-bridge.js";
import { activeAttemptResolution } from "../../infrastructure/state/active-attempt.js";
import { policyConfigFs } from "../runtime/node-adapters.js";
import { postWriteGuardPorts } from "./guard-adapters.js";
import { readStdin } from "./adapters.js";
import { cliEntryPath } from "../runtime/context.js";
import { tryParseJson } from "../../shared/json.js";

const stopFs: HookFsPort & { removeIfExists(absolutePath: string): Promise<void> } = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  removeIfExists: (absolutePath) => nodeFsAdapter.removeIfExists(absolutePath),
};

/**
 * Kokybės vartų statusas Stop keliui.
 *
 * Neperskaitomas arba sugadintas failas yra `undefined`, o ne klaida ir NE žalias statusas:
 * `hookOnStop` iš `undefined` daro TypeScript fallback'ą, t. y. patikrina pats. Tylus „žalia"
 * čia būtų blogiausias variantas — jis atidarytų commit'ą remdamasis nepatikrintu medžiu.
 */
async function readQualityGatesStatus(runtimeRoot: string): Promise<QualityGatesStatus | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(qualityGatesStatusPath(runtimeRoot));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<QualityGatesStatus>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : undefined;
}

export function stopHookPorts(projectRoot: string, runtimeRoot: string): StopHookPorts {
  return {
    ...postWriteGuardPorts(runtimeRoot),
    fs: stopFs,
    env: (name) => process.env[name],
    collectChangedFiles: (root) => collectChangedFiles(root, runtimeRoot),
    isGitRepository: (root) => isGitRepository(root),
    hasGitChanges: async (root) => ((await gitStatusPorcelain(root)) ?? "").trim().length > 0,
    gitStatusPorcelain: async (root) => {
      const stdout = await gitStatusPorcelain(root);
      // `undefined` reiškia, kad pati komanda nepavyko (ne git repo, git nėra). Tai NE tuščias
      // medis, tad kodas yra 1 — kvietėjas turi matyti skirtumą tarp „nieko nepakeista" ir
      // „negaliu pasakyti".
      return stdout === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout, stderr: "" };
    },
    filterGitIgnored: (paths, root) => filterGitIgnored([...paths], root),
    commitAndPush: async (input) => {
      const result = await commitAndPush(input.projectRoot, input.message, run, {
        paths: [...input.paths],
        push: input.push,
      });
      return result.ok
        ? { ok: true, branch: result.branch }
        : {
            ok: false,
            step: result.step,
            result: { code: result.result.code, stdout: result.result.stdout, stderr: result.result.stderr },
          };
    },
    stopBridge: (input) =>
      stopBridgeForProject({
        projectRoot,
        runtimeRoot,
        resolution: activeAttemptResolution({ projectRoot, runtimeRoot }),
        status: input.status,
        reason: input.reason,
        taskId: input.taskId,
      }),
    loadGitAutomationPolicy: (root) => loadGitAutomationPolicy(policyConfigFs, root),
    readQualityGatesStatus: (root) => readQualityGatesStatus(root),
    commandExists: (command) => commandExists(command),
    runShell: async (command, root) => {
      const result = await runShell(command, root);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    // Guard'as paleidžiamas ATSKIRU procesu — ta pati priežastis kaip PostToolUse fan-out'e:
    // kiekvienas jų turi savo stdin ir savo exit kodo semantiką.
    // Stop payload'as skaitomas TIK dėl `session_id` (guard'ų tapatybė). Tas pats `readStdin`
    // su terminu kaip visuose hook'uose: neužsidarantis stdin negali pakabinti Stop hook'o.
    readStdin: () => readStdin(),
    runStopGuard: async (command, root, sessionId) => {
      const result = await run(process.execPath, [cliEntryPath(), command, "stop"], {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          // Sesijos tapatybė guard'ams. TUŠČIA reikšmė nerašoma: `AG_SESSION_ID=""` guard'ui
          // atrodytų kaip nustatyta-bet-tuščia, o skirtumas tarp „nežinau" ir „žinau, kad
          // tuščia" čia yra visa prasmė.
          ...(sessionId ? { AG_SESSION_ID: sessionId } : {}),
        },
      }).catch(() => undefined);
      return result?.code ?? 1;
    },
  };
}
