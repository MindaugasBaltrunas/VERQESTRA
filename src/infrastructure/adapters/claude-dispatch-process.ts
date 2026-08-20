// Platforminis Claude dispatch proceso paleidimas (etalonas: interfaces/cli/claude-dispatch/
// dispatch-process-launch.ts 1:1). Infrastructure: launcher skripto rašymas, run/runWithInput
// su mid-dispatch abort signalu, POSIX nonce env langas ir --disallowed-tools CLI fallback.

import { StringDecoder } from "node:string_decoder";
import { BUDGET_EXCEEDED_EXIT_CODE } from "../../shared/exit-codes.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { run, runWithInput, type CommandResult } from "../process/run-process.js";
import { createVisibleClaudeLauncher } from "./claude-launcher.js";
import { isUnknownFlagFailure } from "./claude-tool-schema.js";
import {
  nonWindowsClaudeDispatchArgs,
  type DispatchPromptDelivery,
  type DispatchToolSchemaProfile,
} from "./claude-dispatch-delivery.js";
import {
  claudeLastLogWriteFatal,
  writeClaudeLastLog,
  type ClaudeLastLogChannels,
  type ClaudeLastLogWriteResult,
} from "./claude-last-log.js";
import {
  MID_DISPATCH_BUDGET_ABORT_REASON,
  MID_DISPATCH_USAGE_POLL_MS,
  startStreamLogTail,
  type MidDispatchBudgetWatchdog,
} from "./mid-dispatch-budget.js";

export type DispatchProcessLaunchInput = {
  delivery: DispatchPromptDelivery;
  visibleLauncher: string;
  projectRoot: string;
  model: string;
  claudeExitFile: string;
  attemptClaudeLog?: string;
  claudeLog: string;
  logChannels: ClaudeLastLogChannels;
  dispatchTimeoutMs: number;
  dispatchMaxTurns?: number;
  dispatchNonce: string;
  toolSchema: DispatchToolSchemaProfile;
  budgetWatchdog: MidDispatchBudgetWatchdog;
  budgetAbortSignal: AbortSignal;
  taskId: string;
  logDispatch(line: string): Promise<void>;
  /**
   * Windows pradinis log'as rašomas prieš procesą. Callback'as užfiksuoja terminalinį
   * execution record ir grąžina true, kai paleidimą reikia nutraukti.
   */
  onWindowsInitialLog(write: ClaudeLastLogWriteResult): Promise<boolean>;
};

export type DispatchProcessLaunchResult =
  | { status: "aborted-before-launch" }
  | {
      status: "finished";
      claudeExit: number;
      budgetAborted: boolean;
      toolSchemaOutcome: DispatchToolSchemaProfile;
    };

/** Platforminį Claude proceso paleidimą izoliuoja nuo aukštesnio lygio dispatch orkestravimo. */
export async function launchClaudeProcess(input: DispatchProcessLaunchInput): Promise<DispatchProcessLaunchResult> {
  let toolSchemaOutcome = input.toolSchema;

  if (input.delivery.platform === "windows") {
    await nodeFsAdapter.writeTextFile(
      input.visibleLauncher,
      createVisibleClaudeLauncher({
        projectRoot: input.projectRoot,
        promptPath: input.delivery.promptPath,
        model: input.model,
        exitFile: input.claudeExitFile,
        logFile: input.attemptClaudeLog ?? input.claudeLog,
        ...(input.attemptClaudeLog === undefined ? {} : { mirrorLogFile: input.claudeLog }),
        dispatchTimeoutMs: input.dispatchTimeoutMs,
        ...(input.dispatchMaxTurns === undefined ? {} : { maxTurns: input.dispatchMaxTurns }),
        dispatchNonce: input.dispatchNonce,
        disallowedTools: input.delivery.disallowedTools,
      }),
    );
    const logWrite = await writeClaudeLastLog(
      input.logChannels,
      `Claude is running in a visible PowerShell task runner.\nPrompt file: ${input.delivery.promptPath}\nModel: ${input.model}\nPowerShell: ${input.delivery.shell}\n`,
    );
    if (await input.onWindowsInitialLog(logWrite)) return { status: "aborted-before-launch" };

    // Windows šakoje outer `run()` stdout NEGAUNA (`Start-Process` = nauja konsolė) —
    // vienintelis gyvas signalas yra launcher'io Tee rašomas log failas.
    const budgetTailer = startStreamLogTail({
      path: input.attemptClaudeLog ?? input.claudeLog,
      intervalMs: MID_DISPATCH_USAGE_POLL_MS,
      onText: (text) => {
        input.budgetWatchdog.observe(text);
      },
    });
    let result: CommandResult;
    try {
      result = await run(
        input.delivery.shell,
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", input.visibleLauncher],
        {
          timeoutMs: input.dispatchTimeoutMs,
          abort: {
            signal: input.budgetAbortSignal,
            exitCode: BUDGET_EXCEEDED_EXIT_CODE,
            reason: MID_DISPATCH_BUDGET_ABORT_REASON,
          },
        },
      );
    } finally {
      await budgetTailer.stop();
    }

    const budgetAborted = result.code === BUDGET_EXCEEDED_EXIT_CODE;
    let claudeExit = result.code;
    const exitFromFile = (await nodeFsAdapter.readTextFileIfExists(input.claudeExitFile))?.trim();
    if (exitFromFile && /^\d+$/.test(exitFromFile)) {
      claudeExit = Number.parseInt(exitFromFile, 10);
    }
    return { status: "finished", claudeExit, budgetAborted, toolSchemaOutcome };
  }

  // POSIX: nonce gyvena env lange TIK proceso metu (task 0056 — vienas nonce abiem
  // platformoms yra zero-usage klasifikacijos prielaida).
  const previousNonce = process.env["AG_DISPATCH_NONCE"];
  process.env["AG_DISPATCH_NONCE"] = input.dispatchNonce;
  const budgetDecoder = new StringDecoder("utf8");
  const retryBudgetDecoder = new StringDecoder("utf8");
  let result: CommandResult;
  try {
    result = await runWithInput(
      input.delivery.command,
      input.delivery.args,
      input.delivery.prompt,
      input.projectRoot,
      input.dispatchTimeoutMs,
      undefined,
      {
        onStdout: (chunk) => {
          input.budgetWatchdog.observe(budgetDecoder.write(chunk));
        },
        abort: {
          signal: input.budgetAbortSignal,
          exitCode: BUDGET_EXCEEDED_EXIT_CODE,
          reason: MID_DISPATCH_BUDGET_ABORT_REASON,
        },
      },
    );
    if (input.toolSchema.applied.length > 0 && isUnknownFlagFailure(result)) {
      toolSchemaOutcome = {
        ...input.toolSchema,
        mode: "cli-fallback",
        applied: [],
        reason: "claude CLI rejected --disallowed-tools; retried without the dispatch tool profile",
      };
      await input.logDispatch(
        `DISPATCH TOOL SCHEMA FALLBACK: task=${input.taskId} exit=${result.code} — retry without --disallowed-tools`,
      );
      result = await runWithInput(
        input.delivery.command,
        nonWindowsClaudeDispatchArgs(input.model, input.dispatchMaxTurns),
        input.delivery.prompt,
        input.projectRoot,
        input.dispatchTimeoutMs,
        undefined,
        {
          onStdout: (chunk) => {
            input.budgetWatchdog.observe(retryBudgetDecoder.write(chunk));
          },
          abort: {
            signal: input.budgetAbortSignal,
            exitCode: BUDGET_EXCEEDED_EXIT_CODE,
            reason: MID_DISPATCH_BUDGET_ABORT_REASON,
          },
        },
      );
    }
  } finally {
    if (previousNonce === undefined) {
      delete process.env["AG_DISPATCH_NONCE"];
    } else {
      process.env["AG_DISPATCH_NONCE"] = previousNonce;
    }
  }

  const logWrite = await writeClaudeLastLog(input.logChannels, `${result.stdout}${result.stderr}`);
  if (claudeLastLogWriteFatal(logWrite)) {
    await input.logDispatch(
      `DISPATCH LOG UNWRITABLE AFTER RUN: task=${input.taskId} exit=${result.code} — ${logWrite.errors.join("; ")}`,
    );
  } else if (logWrite.errors.length > 0) {
    await input.logDispatch(`DISPATCH LOG MIRROR DEGRADED: task=${input.taskId} — ${logWrite.errors.join("; ")}`);
  }
  return {
    status: "finished",
    claudeExit: result.code,
    budgetAborted: result.code === BUDGET_EXCEEDED_EXIT_CODE,
    toolSchemaOutcome,
  };
}
