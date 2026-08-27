// `claude-preflight` portų surišimas (manual DI, LAY-2).
//
// Preflight'as yra PASKUTINĖ vieta, kur task'ui dar galima pasakyti „ne" prieš paleidžiant
// modelį: po dispatch'o kontekstas jau pamatytas ir failai jau pakeisti. Todėl kiekvienas
// sprendimas čia krypsta į griežtesnę pusę — trūkstama politika nutraukia, neišsprendžiamas
// OpenSpec change veda į human-review (o ne į begalinį retry), o attempt artefaktai lieka
// best-effort ir negali nuversti paties sprendimo.

import path from "node:path";
import { loadAgentPolicy } from "../../application/policy-governance/agent-policy.js";
import { loadQualityPolicy, resolveQualityChecks } from "../../application/policy-governance/quality-policy.js";
import { DIST_REBUILD_COMMAND } from "../../application/release-readiness/build-gate.js";
import type { VerificationCommands } from "../../application/quality-gates/preflight-rules.js";
import { authorizeLlmCall, type LlmCallAuthorization } from "../../application/token-governance/tool-budget-gates.js";
import type { TaskPhase } from "../../domain/tokens/usage-ledger.js";
import { ensureFreshCodeIndexForExistingCodeTask } from "../../application/code-intelligence/query/guard.js";
import type { OpenSpecContextPorts } from "../../application/task-planning/openspec-context.js";
import { taskLedgerKey } from "../../domain/tasks/identity.js";
import type { ClaudePreflightPorts } from "../../interfaces/cli/dispatch/claude-preflight/preflight-ports.js";
import { claudeModelSelectionRules, runClaudeHeadless } from "../../infrastructure/adapters/claude-headless.js";
import { extractResultField, extractUsage, isUsageLimitOutput } from "../../infrastructure/adapters/claude-usage.js";
import { extractDecisionJson } from "../../infrastructure/adapters/claude-decision.js";
import { generateOpenSpecChange, writeTemplateOpenSpecChange } from "../../infrastructure/bootstrap/openspec-autogen.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { resolveExistingDispatchTaskFile } from "../../infrastructure/state/dispatch-task-file.js";
import { ensureRuntimeDirs } from "../../infrastructure/state/runtime-dirs.js";
import { recordResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import { logTokenUsage } from "../../infrastructure/state/token-usage-log.js";
import type { AttemptResolutionPort } from "../../infrastructure/state/attempt-resolution.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { codeIntelligenceFs, policyConfigFs, tokenBudgetPorts } from "../runtime/node-adapters.js";
import { readOptionalFile, resolveDiagnosisModel } from "../quality/diagnose-adapters.js";
import { resolveModelForTier } from "../quality/adapters.js";
import { appendLogLine } from "../loop/adapters.js";

export type ClaudePreflightAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  resolution: AttemptResolutionPort;
};

/** OpenSpec konteksto portai: spec medžio skaitymas plius katalogo patikra. */
export const openSpecContextPorts: OpenSpecContextPorts = {
  fs: {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  },
  isDirectory: async (absolutePath) => (await nodeFsAdapter.statKind(absolutePath)) === "directory",
};

/**
 * Projekto profilis. Trūkstamas ar sugadintas duoda `undefined`, o ne klaidą: profilis čia
 * naudojamas tik `source_roots` užuominai, o jos nebuvimas nieko neatrakina — tik praplečia
 * paiešką. Klaida dėl neprivalomos užuominos sustabdytų visą preflight'ą.
 */
/**
 * Ką agentui vadinti „patikra" ir „perstatymas".
 *
 * `task` scope, o ne `milestone`: sandbox blokas kalba apie VIENOS užduoties ciklą, o milestone
 * komandų rinkinys projektuose būna platesnis (release patikros, benchmark). Nepasiekiama arba
 * tuščia politika grąžina tik perstatymo komandą — geriau viena tikra eilutė nei sąrašas
 * komandų, kurių projekte nėra.
 */
export async function verificationCommands(runtimeRoot: string): Promise<VerificationCommands> {
  const checks = await loadQualityPolicy(policyConfigFs, runtimeRoot)
    .then((policy) => resolveQualityChecks(policy, "task").map((check) => check.display))
    .catch(() => []);
  return { rebuild: DIST_REBUILD_COMMAND, checks };
}

export async function loadProjectProfile(runtimeRoot: string): Promise<{ source_roots?: string[] } | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "project", "profile.json"));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<{ source_roots?: string[] }>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : undefined;
}

/** `.claude/agents` failų vardai; nesamas katalogas — tuščias sąrašas. */
export function listAgentFiles(projectRoot: string): Promise<string[]> {
  return nodeFsAdapter.listFiles(path.join(projectRoot, ".claude", "agents"));
}

/**
 * Visi `claude-preflight` portai vienu pjūviu.
 *
 * Task id, kaip ir diagnozėje, yra LAZY: attempt artefaktų keliai jo reikalauja, o jis gimsta
 * tik iš argumento išspręsto task failo. Komanda `resolveExistingTaskFile` kviečia pirmiausia.
 */
export function claudePreflightPorts(input: ClaudePreflightAdapterInput): ClaudePreflightPorts {
  let taskId = "";

  const withAttempt = async (
    action: (handle: { appendLog(channel: string, line: string): Promise<unknown> }) => Promise<void>,
  ): Promise<void> => {
    if (taskId.trim() === "") return;
    const resolved = await input.resolution.resolveActiveAttempt(taskId);
    if (!resolved.ok) return;
    try {
      await action(resolved.attempt.handle);
    } catch {
      // Attempt artefaktai best-effort: jų klaida nekeičia preflight verdikto.
    }
  };

  const supervisor = (name: string): string => path.join(input.runtimeRoot, "supervisor", name);

  return {
    projectRoot: input.projectRoot,
    runtimeRoot: input.runtimeRoot,
    agRoot: input.agRoot,

    ensureDirs: () => ensureRuntimeDirs(input.agRoot, input.runtimeRoot),
    resolveExistingTaskFile: async (taskFileArg) => {
      const resolved = await resolveExistingDispatchTaskFile(input.projectRoot, taskFileArg);
      taskId = taskLedgerKey(resolved);
      return resolved;
    },
    readOptionalFile: (absolutePath) => readOptionalFile(absolutePath),
    listAgentFiles: () => listAgentFiles(input.projectRoot),
    loadAgentPolicy: () => loadAgentPolicy(policyConfigFs, input.runtimeRoot),
    loadProjectProfile: () => loadProjectProfile(input.runtimeRoot),
    verificationCommands: () => verificationCommands(input.runtimeRoot),

    policyFs: policyConfigFs,
    openSpec: openSpecContextPorts,

    authorizeLlmCall: (id: string, phase: TaskPhase): Promise<LlmCallAuthorization> =>
      authorizeLlmCall(tokenBudgetPorts(input.runtimeRoot), input.runtimeRoot, { taskId: id, phase }),

    // Nepavykęs generavimas grąžina `null`, o ne meta: kvietėjas tada krenta į human-review.
    // Išimtis čia reikštų nutrauktą preflight'ą be jokio sprendimo dokumento.
    generateChange: (taskText, id, agRootDir, model) =>
      generateOpenSpecChange(taskText, id, agRootDir, model, { runtimeRoot: input.runtimeRoot }),
    writeTemplateChange: (taskText, id, agRootDir) => writeTemplateOpenSpecChange(taskText, id, agRootDir),

    resolveModel: (tier) => resolveModelForTier(input.runtimeRoot, tier),
    modelSelectionRules: claudeModelSelectionRules,
    runHeadless: async (prompt, model, options) => {
      const stateDir = path.join(input.runtimeRoot, "state");
      await nodeFsAdapter.makeDirectory(stateDir);
      const previousCwd = process.cwd();
      try {
        process.chdir(input.projectRoot);
        return await runClaudeHeadless(prompt, model, stateDir, {
          maxTurns: options.maxTurns,
          disallowWriteTools: options.disallowWriteTools,
        });
      } finally {
        process.chdir(previousCwd);
      }
    },
    parseDecision: (stdout) => extractDecisionJson(extractResultField(stdout)),
    isUsageLimitOutput: (stdout) => isUsageLimitOutput(stdout),
    logTokenUsage: (phase, model, stdout) => {
      const usage = stdout === undefined ? undefined : extractUsage(stdout);
      return logTokenUsage({
        runtimeRoot: input.runtimeRoot,
        resolution: input.resolution,
        phase,
        taskId,
        model,
        ...(usage === undefined ? {} : { usage }),
      });
    },

    ensureFreshCodeIndex: (allowedFiles) =>
      ensureFreshCodeIndexForExistingCodeTask(codeIntelligenceFs(input.projectRoot), input.projectRoot, allowedFiles),

    attempt: {
      writeDecision: (decision) =>
        withAttempt(async (handle) => {
          await handle.appendLog("decision", JSON.stringify(decision));
        }),
      writeTask: (body) =>
        withAttempt(async (handle) => {
          await handle.appendLog("task", body);
        }),
      appendPreflightInput: (prompt) =>
        withAttempt(async (handle) => {
          await handle.appendLog("preflight-input", prompt);
        }),
    },
    files: {
      writeDecision: (json) => nodeFsAdapter.writeTextFile(supervisor("decision.json"), json),
      writeReformulated: (body) => nodeFsAdapter.writeTextFile(supervisor("reformulated-task.md"), body),
      // Paskutinis promptas PERRAŠOMAS: jo vertė yra „ką siuntėme dabar", o istoriją laiko
      // attempt kanalas. Append čia paverstų failą augančiu šiukšlynu be jokio skaitytojo.
      writePreflightInput: (text) => nodeFsAdapter.writeTextFile(supervisor("preflight-input.md"), text),
      writeSupervisorLog: (text) =>
        nodeFsAdapter.writeTextFile(path.join(input.runtimeRoot, "logs", "supervisor-last.log"), text),
      dirExists: async (relativeDir) =>
        (await nodeFsAdapter.statKind(path.join(input.projectRoot, relativeDir))) === "directory",
    },
    recordResumeCheckpoint: (entry) =>
      recordResumeCheckpoint({
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        resolution: input.resolution,
        checkpoint: entry,
      }),
    agLog: (line) => appendLogLine(input.runtimeRoot, "orchestrator.log", line),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

export { resolveDiagnosisModel, toPrettyJson };
