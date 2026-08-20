// Dispatch baigties normalizavimas (etalonas: interfaces/cli/claude-dispatch/
// dispatch-outcome.ts 1:1). Usage-limit sprendimas visada priimamas PRIEŠ mid-dispatch
// budget sprendimą — realus budget abort'as lieka aukštesnio prioriteto. Stop-bridge
// laukimo taisyklės — application/task-execution/stop-bridge-wait; srauto extractoriai —
// claude-usage; globalus stop failas — vq/state/claude-stop-status.json.

import path from "node:path";
import { BUDGET_EXCEEDED_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../../shared/exit-codes.js";
import type { ResolvedTokenBudget } from "../../application/token-governance/token-budget-config.js";
import {
  STOP_BRIDGE_WAIT_POLL_MS,
  isEmptyDispatchUsage,
  isZeroUsageLimitSignal,
  mergeStopBridgeSources,
  shouldWaitForOwnStopBridge,
  stopBridgeWaitMs,
  waitForOwnStopBridgeDone,
  type StopBridgeProbe,
  type StopBridgeProbeResult,
} from "../../application/task-execution/stop-bridge-wait.js";
import { extractResultEnvelopeFromStreamJsonLog } from "../../domain/diagnosis/stream-log.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import type { ClaudeUsage } from "../state/token-usage-log.js";
import { extractUsageFromStreamJsonLog, isUsageLimitEnvelope, usageFromStreamTotals } from "./claude-usage.js";
import {
  billableMeterBlindNotice,
  billableTokensOfStream,
  type MidDispatchBudgetVerdict,
  type MidDispatchBudgetWatchdog,
} from "./mid-dispatch-budget.js";

export type AttemptStopStateRead =
  | { ok: true; data: unknown }
  | { ok: false; reason: string; errors: string[] };

export type DispatchOutcome = {
  exitCode: number;
  usage?: ClaudeUsage;
  usageLimitHit: boolean;
  zeroUsageSuccess: boolean;
  stopBridgeDone: boolean;
  budgetVerdict?: MidDispatchBudgetVerdict;
};

export type ResolveDispatchOutcomeInput = {
  /** VERQESTRA runtime šaknis (`<root>/vq`) — globaliam stop-bridge failui. */
  runtimeRoot: string;
  taskId: string;
  initialExitCode: number;
  claudeLogText: string;
  dispatchNonce: string;
  budgetWatchdog: MidDispatchBudgetWatchdog;
  budgetAborted: boolean;
  tokenBudget: ResolvedTokenBudget;
  sessionElapsedMs: number;
  dispatchTimeoutMs: number;
  readAttemptStopState?: () => Promise<AttemptStopStateRead>;
  logDispatch(line: string): Promise<void>;
};

/**
 * Normalizuoja proceso baigtį: stream usage → stop-bridge laukimo langas (1213) →
 * zero-usage/usage-limit klasifikacija → raw notice diagnostika → budget verdiktas.
 */
export async function resolveDispatchOutcome(input: ResolveDispatchOutcomeInput): Promise<DispatchOutcome> {
  let exitCode = input.initialExitCode;
  const resultUsage = extractUsageFromStreamJsonLog(input.claudeLogText);
  const usage =
    resultUsage ?? (input.budgetWatchdog.hit() ? usageFromStreamTotals(input.budgetWatchdog.totals()) : undefined);
  const resultEnvelope = extractResultEnvelopeFromStreamJsonLog(input.claudeLogText);
  const usageLimitHit = resultEnvelope !== undefined && isUsageLimitEnvelope(resultEnvelope);

  const globalStopBridgeFile = path.join(input.runtimeRoot, "state", "claude-stop-status.json");
  const probeDegradedSeen = new Set<string>();
  const probeStopBridge: StopBridgeProbe = async () => {
    try {
      let attemptRaw: string | undefined;
      if (input.readAttemptStopState !== undefined) {
        const read = await input.readAttemptStopState();
        if (read.ok) {
          attemptRaw = JSON.stringify(read.data);
        } else if (read.reason !== "missing" && !probeDegradedSeen.has(read.reason)) {
          probeDegradedSeen.add(read.reason);
          await input.logDispatch(
            `DISPATCH STOP WAIT PROBE DEGRADED: task=${input.taskId} reason=${read.reason} — ${read.errors.join("; ")}`,
          );
        }
      }
      return mergeStopBridgeSources(
        attemptRaw,
        (await nodeFsAdapter.readTextFileIfExists(globalStopBridgeFile)) ?? "",
        input.dispatchNonce,
      );
    } catch {
      return { classification: "none", source: "none" };
    }
  };

  const firstProbe = await probeStopBridge();
  let stopBridgeEvidence: StopBridgeProbeResult = firstProbe;
  const stopBridgeWindowMs = stopBridgeWaitMs();
  if (
    shouldWaitForOwnStopBridge({
      exitCode,
      usage,
      usageLimitHit,
      observed: firstProbe.classification,
    }) &&
    stopBridgeWindowMs > 0
  ) {
    await input.logDispatch(
      `DISPATCH STOP WAIT: task=${input.taskId} window_ms=${stopBridgeWindowMs} ` +
        `poll_ms=${STOP_BRIDGE_WAIT_POLL_MS} — ` +
        `laukiama savo stop-bridge įrodymo (exit=0, tuščia usage, be result envelope)`,
    );
    const waited = await waitForOwnStopBridgeDone({
      probe: probeStopBridge,
      timeoutMs: stopBridgeWindowMs,
      pollMs: STOP_BRIDGE_WAIT_POLL_MS,
    });
    await input.logDispatch(
      `DISPATCH STOP WAIT RESULT: task=${input.taskId} ` +
        `result=${waited.classification === "own-done" ? "own-done" : "timeout"} ` +
        `classification=${waited.classification} source=${waited.source} ` +
        `waited_ms=${waited.waitedMs} polls=${waited.polls}`,
    );
    stopBridgeEvidence = waited;
  }

  const stopBridgeDone = stopBridgeEvidence.classification === "own-done";
  if (stopBridgeEvidence.classification === "foreign-done") {
    await input.logDispatch(
      `DISPATCH STOP BRIDGE FOREIGN: task=${input.taskId} status=done bet dispatch_nonce nesutampa — ignoruojama`,
    );
  }
  const zeroUsageSuccess = isZeroUsageLimitSignal(exitCode, usage, stopBridgeDone);
  if (exitCode === 0 && isEmptyDispatchUsage(usage) && stopBridgeDone) {
    await input.logDispatch(
      `DISPATCH USAGE ADVISORY: task=${input.taskId} zero usage bet stop bridge done — ` +
        `nukirstas stream log, NE limitas`,
    );
  }
  if (usageLimitHit || zeroUsageSuccess) {
    await input.logDispatch(
      `DISPATCH USAGE LIMIT: task=${input.taskId} exit=${exitCode} ` +
        `reason=${usageLimitHit ? "usage-limit-result" : "zero-usage-success"} — ` +
        `marking infra (${USAGE_LIMIT_EXIT_CODE})`,
    );
    exitCode = USAGE_LIMIT_EXIT_CODE;
  }

  // Task 0000-0a: RAW perviršis — tik diagnostinis pėdsakas, baigtis nekeičiama.
  const rawTotals = input.budgetWatchdog.totals();
  if (rawTotals.total_tokens > input.tokenBudget.maxDispatchTokens) {
    await input.logDispatch(
      `DISPATCH RAW TOKEN NOTICE: task=${input.taskId} raw=${rawTotals.total_tokens} ` +
        `raw_ceiling=${input.tokenBudget.maxDispatchTokens} ` +
        `billable=${billableTokensOfStream(rawTotals)} ` +
        `budget_source=maxDispatchTokens:${input.tokenBudget.sources.maxDispatchTokens} — ` +
        `diagnostika, baigtis nekeičiama`,
    );
  }
  const blindNotice = billableMeterBlindNotice({
    taskId: input.taskId,
    billableSeen: input.budgetWatchdog.billableSeen(),
    elapsedMs: input.sessionElapsedMs,
    timeoutMs: input.dispatchTimeoutMs,
    totals: rawTotals,
  });
  if (blindNotice) await input.logDispatch(blindNotice);

  // Task 1203: exit'as perrašomas TIK kai sesiją nutraukė BŪTENT biudžeto abort'as —
  // riba, peržengta jau pasibaigus sesijai, yra advisory (darbas jau commit'intas).
  const budgetVerdict = input.budgetWatchdog.hit();
  if (budgetVerdict && input.budgetAborted) {
    await input.logDispatch(
      `DISPATCH BUDGET ABORT: task=${input.taskId} exit=${exitCode} reason=${budgetVerdict.reason} ` +
        `billable=${budgetVerdict.billableTokens} raw=${budgetVerdict.rawTokens} ` +
        `limit=${budgetVerdict.limit} limit_source=${budgetVerdict.limitSource} — ` +
        `marking infra (${BUDGET_EXCEEDED_EXIT_CODE})`,
    );
    exitCode = BUDGET_EXCEEDED_EXIT_CODE;
  } else if (budgetVerdict) {
    await input.logDispatch(
      `DISPATCH BUDGET ADVISORY: task=${input.taskId} exit=${exitCode} reason=${budgetVerdict.reason} ` +
        `billable=${budgetVerdict.billableTokens} raw=${budgetVerdict.rawTokens} ` +
        `limit=${budgetVerdict.limit} limit_source=${budgetVerdict.limitSource} — ` +
        `riba peržengta jau pasibaigus sesijai, baigtis nekeičiama`,
    );
  }

  return {
    exitCode,
    ...(usage === undefined ? {} : { usage }),
    usageLimitHit,
    zeroUsageSuccess,
    stopBridgeDone,
    ...(budgetVerdict === undefined ? {} : { budgetVerdict }),
  };
}
