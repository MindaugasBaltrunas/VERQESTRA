// `requeue` CLI adapteris (etalonas: interfaces/cli/requeue/index.ts). Requeue yra aiškus
// žmogaus „bandyk dar kartą": task grįžta iš human-review į queue, ledger'io įrašas
// išvalomas, o LLM biudžeto skaitiklis resetinamas (etalono 1073/1074 lockout pamoka —
// ankstesnių, dažnai infra-nutrauktų, ratų istorija nebeturi deginti max_llm_calls).

import path from "node:path";
import { taskLedgerKey } from "../../../domain/tasks/index.js";
import { moveTaskToBucket, type TaskStateStorePort } from "../../../application/task-execution/bucket-transition.js";
import { clearTaskLedgerEntry, type TaskLedgerStorePort } from "../../../application/task-execution/task-ledger-service.js";
import { recordLlmCallReset, type TokenBudgetGatePorts } from "../../../application/token-governance/tool-budget-gates.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type RequeueCommandDeps = {
  store: TaskStateStorePort;
  ledger: TaskLedgerStorePort;
  /** Biudžeto vartų portai — runtime šaknį (`<root>/vq`) jie neša savyje (E4 fabrikas). */
  budget: TokenBudgetGatePorts;
  isFile(absolutePath: string): Promise<boolean>;
  projectRoot: string;
  io?: CliIo;
};

export async function requeueTask(args: string[], deps: RequeueCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const [taskArg] = args;

  if (!taskArg) {
    io.error("Usage: ag requeue <task-file-or-name>");
    io.error("  Examples:");
    io.error("    ag requeue 13_api_filtering.md");
    io.error("    ag requeue AG/tasks/human-review/13_api_filtering.md");
    return 2;
  }

  const agRoot = path.join(path.resolve(deps.projectRoot), "AG");
  const taskName = taskArg.endsWith(".md") ? path.basename(taskArg) : `${taskArg}.md`;
  const source = path.join(agRoot, "tasks", "human-review", taskName);

  if (!(await deps.isFile(source))) {
    io.error(`Not found in human-review: ${taskName}`);
    return 2;
  }

  const taskId = taskLedgerKey(source);
  const cleared = await clearTaskLedgerEntry(deps.ledger, taskId);
  await recordLlmCallReset(deps.budget, taskId);
  await moveTaskToBucket(deps.store, agRoot, source, "queue", taskName, { updateCurrent: false });

  io.out(`requeued: ${taskName}`);
  if (cleared) io.out(`ledger cleared: ${taskId}`);
  io.out(`llm budget reset: ${taskId}`);
  return 0;
}
