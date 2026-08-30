// Autoritetinga dispatch tapatybė iš CLI argumentų, task failo ir attempt manifesto
// (etalonas: interfaces/cli/claude-dispatch/dispatch-invocation.ts 1:1). Jokių globalių
// process/console mutacijų — atsisakymą ir įspėjimus apdoroja CLI sluoksnis.

import path from "node:path";
import { isRepairDispatchPrompt } from "../../../../application/task-execution/execution-context-gate.js";
import type { ClaudeDispatchPorts, DispatchAttemptView, DispatchDecision } from "./dispatch-ports.js";

export type PrepareDispatchInvocationResult =
  | { kind: "refuse"; message: string; logLine?: string }
  | {
      kind: "ready";
      taskFile: string;
      rawTaskText: string;
      dispatchPhase: "repair" | "implementation";
      taskId: string;
      decision: DispatchDecision;
      selected: string;
      active?: DispatchAttemptView;
      /** `resolved.claudeLogPath` — attempt claude-last kelias net be pilno `active` view. */
      claudeLogPath?: string;
      warnings: string[];
    };

export async function prepareDispatchInvocation(
  args: string[],
  ports: Pick<
    ClaudeDispatchPorts,
    "resolveExistingTaskFile" | "readOptionalFile" | "readCurrentTaskId" | "resolveAttempt" | "readSupervisorDecision"
  >,
): Promise<PrepareDispatchInvocationResult> {
  const taskFileArg = args[0];
  if (!taskFileArg) {
    return { kind: "refuse", message: "Usage: verqestra claude-dispatch <task-file>" };
  }

  let taskFile: string;
  try {
    taskFile = await ports.resolveExistingTaskFile(taskFileArg);
  } catch (error) {
    return { kind: "refuse", message: error instanceof Error ? error.message : String(error) };
  }

  const taskIdArgIndex = args.indexOf("--task-id");
  const taskIdArg = taskIdArgIndex >= 0 ? args[taskIdArgIndex + 1]?.trim() || undefined : undefined;
  let decision: DispatchDecision = {};
  const rawTaskText = await ports.readOptionalFile(taskFile);
  const dispatchPhase: "repair" | "implementation" = isRepairDispatchPrompt(rawTaskText) ? "repair" : "implementation";
  const taskFileId = path.basename(taskFile, path.extname(taskFile));
  // Tapatybės kandidatas čia — TIK iš argumento: `decision` užpildomas tik žemiau (attempt
  // arba globalus veidrodis), tad ankstesnis `decision.task_id?.trim()` buvo negyva šaka,
  // maskavusi faktą, kad sprendimas dispatch'o dar nepasiekė (2026-08-25 auditas, P0-1).
  const resolved = await ports.resolveAttempt({
    taskId: taskIdArg || taskFileId,
    phase: dispatchPhase,
    taskFile,
  });
  const active = resolved.attempt;
  const warnings = [...resolved.warnings];

  let taskId: string;
  if (active) {
    taskId = active.taskId;
  } else {
    const currentTaskId = await ports.readCurrentTaskId();
    taskId = taskIdArg || currentTaskId.trim() || taskFileId;
  }

  let decisionLoaded = false;
  if (active) {
    const attemptDecision = await active.readDecision();
    if (attemptDecision.kind === "ok") {
      decision = attemptDecision.decision;
      decisionLoaded = true;
    } else if (attemptDecision.kind === "invalid") {
      const detail = attemptDecision.errors.join("; ");
      return {
        kind: "refuse",
        message: `Invalid attempt decision.json — refusing to dispatch: ${detail}`,
        logLine: `DISPATCH REFUSED: invalid attempt decision task=${taskId} reason=${attemptDecision.reason}: ${detail}`,
      };
    }
  }

  // 0941 atsarginis kanalas (2026-08-25 auditas, P0-1): be attempt sprendimo preflight
  // paskelbtas tier'as/modelis dispatch'o nepasiekdavo NIEKADA — visi turn langai krisdavo
  // į struktūrinį fallback'ą. Veidrodis priimamas tik su šio task'o `task_id` (nuosavybės
  // patikra kaip `coordinator-adapters.readDecision`); neperskaitomas failas — MATOMAS
  // įspėjimas, bet ne stabdis, nes sugadintas veidrodis gali būti svetimo task'o liekana.
  if (!decisionLoaded) {
    const mirror = await ports.readSupervisorDecision(taskId);
    if (mirror.kind === "ok") {
      decision = mirror.decision;
    } else if (mirror.kind === "invalid") {
      warnings.push(
        `WARNING: unreadable global supervisor decision.json task=${taskId} — ` +
          `dispatching with structural budget fallback: ${mirror.errors.join("; ")}`,
      );
    }
  }

  return {
    kind: "ready",
    taskFile,
    rawTaskText,
    dispatchPhase,
    taskId,
    decision,
    // `none`, kai supervisor pasirinkimo nėra: hardcoded `sonnet` čia 09:41–10:06 log'uose
    // atrodė kaip routing klaida (`selected=sonnet model=claude-haiku-4-5`), nors routing'as
    // buvo teisus — melavo šis laukas. Routing'as `selected` nenaudoja (jis skaito
    // `decision.selected_model`), tad reikšmė čia yra grynai žurnalo/įrašų tiesa.
    selected: decision.selected_model ?? "none",
    ...(active === undefined ? {} : { active }),
    ...(resolved.claudeLogPath === undefined ? {} : { claudeLogPath: resolved.claudeLogPath }),
    warnings,
  };
}
