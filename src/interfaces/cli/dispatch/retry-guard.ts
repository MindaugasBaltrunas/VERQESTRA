// `retry-guard` CLI adapteris (etalonas: interfaces/cli/retry-guard/index.ts). Kanoninis
// F8 repair-dispatch-count limito įėjimas: kviečiamas vieną kartą per `verdict=repair`
// PRIEŠ atitinkamą repair dispatch'ą — `taskCount` reiškia „repair dispatch'ai įskaitant šį",
// o limitas blokuoja dispatch'ą, kuris tą skaičių pasiektų/viršytų. Skaitiklių mutacija —
// application/task-execution/retry-counts (ta pati, kurią naudoja retry-repair kompozicija);
// limito taisyklė — domain/tasks/retry per sankcionuotą application tiltą.

import {
  evaluateRetryLimit,
  incrementTaskRetryCount,
  type RetryCountsStorePort,
  type SupervisorRetryDecision,
} from "../../../application/task-execution/retry-counts.js";

export type RetryGuardCommandDeps = {
  ensureDirs(): Promise<void>;
  /** `vq/supervisor/decision.json`; trūkstamas/sugadintas → `{}` (etalono readJson fallback). */
  readDecision(): Promise<SupervisorRetryDecision>;
  counts: RetryCountsStorePort;
  /** MAX_RETRIES_PER_ERROR iš `vq/config/commands.env` (default'ą taiko krautuvas). */
  maxRetriesPerError(): Promise<number>;
  /** Aktyvaus task'o id iš `vq/state/current-task-id`; `undefined` kai failo nėra. */
  readCurrentTaskId(): Promise<string | undefined>;
  /** `vq/state/last-error-signatures.json` (task-scoped žemėlapis diagnozei). */
  readErrorSignatures(): Promise<Record<string, string>>;
  writeErrorSignatures(signatures: Record<string, string>): Promise<void>;
  /** Legacy operatoriaus artefaktas `vq/state/last-error-signature` (sena įranga jį skaito). */
  writeLegacyErrorSignature(text: string): Promise<void>;
  /** Bendra loop žurnalo eilutė (etalono agLog). */
  agLog(line: string): Promise<void>;
  /** `vq/logs/error.log` append'as. */
  appendErrorLog(text: string): Promise<void>;
  now?: () => Date;
};

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1]?.trim() || undefined;
}

async function resolveTaskId(
  args: string[],
  decision: SupervisorRetryDecision,
  deps: RetryGuardCommandDeps,
): Promise<string | undefined> {
  return (argValue(args, "--task-id") ?? decision.task_id ?? (await deps.readCurrentTaskId()))?.trim();
}

export async function retryGuard(args: string[], deps: RetryGuardCommandDeps): Promise<number> {
  await deps.ensureDirs();
  const now = deps.now ?? (() => new Date());

  const decision = await deps.readDecision();

  if (decision.verdict !== "repair") {
    // Tuščias verdict reiškia trūkstamą arba korumpuotą decision.json — fiksuojama auditui.
    await deps.agLog(`RETRY GUARD SKIPPED: verdict=${decision.verdict ?? "<missing-or-corrupted-decision>"}`);
    return 0;
  }

  const taskId = await resolveTaskId(args, decision, deps);
  if (!taskId) {
    await deps.appendErrorLog(
      [
        "=== RETRY GUARD MISSING TASK ID ===",
        `date=${now().toISOString()}`,
        "Retry limit cannot be enforced without a deterministic task_id.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const retryKey = decision.retry_key ?? decision.error_signature ?? "unknown-error";
  const countUpdate = await incrementTaskRetryCount(deps.counts, taskId, retryKey);
  const limit = evaluateRetryLimit(countUpdate.taskCount, await deps.maxRetriesPerError());

  const signatures = await deps.readErrorSignatures();
  signatures[taskId] = retryKey;
  await deps.writeErrorSignatures(signatures);
  // Legacy operatoriaus artefaktas paliekamas senai įrangai; diagnozė skaito task-scoped žemėlapį.
  await deps.writeLegacyErrorSignature(`${retryKey}\n`);
  await deps.agLog(
    [
      "RETRY:",
      `task=${taskId}`,
      `task_count=${countUpdate.taskCount}`,
      `retry_key=${retryKey}`,
      `error_count=${countUpdate.errorCount}`,
      `max=${limit.max}`,
      `remaining=${limit.remaining}`,
    ].join(" "),
  );

  if (limit.reached) {
    await deps.appendErrorLog(
      [
        "=== MAX RETRIES REACHED ===",
        `date=${now().toISOString()}`,
        `task_id=${taskId}`,
        `task_key=${countUpdate.taskKey}`,
        `task_count=${countUpdate.taskCount}`,
        `retry_key=${retryKey}`,
        `error_key=${countUpdate.errorKey}`,
        `error_count=${countUpdate.errorCount}`,
        `max=${limit.max}`,
        "routing=human-review-after-rollback",
        "",
      ].join("\n"),
    );
    return 1;
  }
  return 0;
}
