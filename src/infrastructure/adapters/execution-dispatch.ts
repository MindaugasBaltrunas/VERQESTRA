// `verqestra dispatch` vykdymo kelias (etalonas: orchestrator/runtime/workflow.ts
// `runExecutionDispatch`). VERQESTRA keliai: `vq/supervisor/*`, `vq/state/*`.
//
// Šio modulio esmė — TRYS PRIELAIDŲ VARTAI prieš bet kokį adapterio paleidimą: praėjęs
// preflight sprendimas, praėję biudžeto vartai ir ŠIAM task'ui priklausantis context-pack.
// Kiekvienas jų atsisako dirbti atskirai ir garsiai, nes agento paleidimas be jų yra
// neatšaukiamas: modelis jau pamatė kontekstą ir jau pakeitė failus.
//
// Trūkstamas ir sugadintas artefaktas skiriami sąmoningai: pirmas reiškia „šis žingsnis dar
// nepadarytas", antras — „šis žingsnis melavo". Operatoriui tai skirtingi veiksmai.

import path from "node:path";
import { taskFileStem } from "../../domain/tasks/identity.js";
import type { ExecutionAdapter } from "../../domain/agents/execution-port.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Etalono `DispatchResult` forma 1:1. */
export type ExecutionDispatchResult = {
  adapter: string;
  status: "completed" | "failed";
  task_id: string;
  summary: string;
  result_path: string;
};

export type ExecutionDispatchInput = {
  taskFile: string;
  projectRoot: string;
  runtimeRoot: string;
  adapter: ExecutionAdapter;
  model?: string;
};

async function readRequiredJson<T>(filePath: string, label: string): Promise<T> {
  const raw = await nodeFsAdapter.readTextFileIfExists(filePath);
  if (raw === undefined) throw new Error(`Dispatch refused: ${label} is missing`);
  const parsed = tryParseJson<T>(raw);
  if (!parsed.ok) throw new Error(`Dispatch refused: ${label} is invalid`);
  return parsed.value;
}

/** Modelio užuomina iš context-pack `agent.model_hint`; tuščia reikšmė — jokios užuominos. */
function contextPackModelHint(contextPack: Record<string, unknown>): string | undefined {
  const agent = contextPack["agent"];
  if (agent === null || typeof agent !== "object") return undefined;
  const hint = (agent as { model_hint?: unknown }).model_hint;
  return typeof hint === "string" && hint.trim() !== "" ? hint.trim() : undefined;
}

export async function runExecutionDispatch(input: ExecutionDispatchInput): Promise<ExecutionDispatchResult> {
  const root = path.resolve(input.projectRoot);
  const taskPath = path.isAbsolute(input.taskFile) ? input.taskFile : path.resolve(root, input.taskFile);
  const taskId = taskFileStem(taskPath);
  const supervisor = path.join(input.runtimeRoot, "supervisor");

  const preflight = await readRequiredJson<{ task_id?: string; verdict?: string }>(
    path.join(supervisor, "preflight-decision.json"),
    "preflight result",
  );
  // `task_id` tikrinamas KARTU su verdiktu: praėjęs kito task'o preflight'as yra svetimas
  // įrodymas, o ne šio task'o leidimas.
  if (preflight.verdict !== "pass" || preflight.task_id !== taskId) {
    throw new Error(`Dispatch refused: valid preflight success is required for task ${taskId}`);
  }

  const budget = await readRequiredJson<{ budget_enforcement?: { ok?: boolean } }>(
    path.join(input.runtimeRoot, "state", "token-budget-status.json"),
    "budget result",
  );
  if (budget.budget_enforcement?.ok !== true) {
    throw new Error("Dispatch refused: budget enforcement success is required");
  }

  const contextPackPath = path.join(supervisor, "context-pack.json");
  const contextPack = await readRequiredJson<Record<string, unknown>>(contextPackPath, "context pack");
  if (
    contextPack["task_id"] !== taskId ||
    !Array.isArray(contextPack["allowed_paths"]) ||
    typeof contextPack["goal"] !== "string"
  ) {
    throw new Error("Dispatch refused: context pack is invalid or belongs to another task");
  }

  // Eksplicitinis `--model` nugali context-pack užuominą; tuščia eilutė NĖRA pasirinkimas.
  const explicitModel = input.model?.trim();
  const model = explicitModel !== undefined && explicitModel !== "" ? explicitModel : contextPackModelHint(contextPack);
  const execution = await input.adapter.execute({
    taskId,
    contextPackPath,
    contextPack,
    allowedPaths: (contextPack["allowed_paths"] as unknown[]).filter((value): value is string => typeof value === "string"),
    ...(model === undefined ? {} : { model }),
  });

  const resultPath = path.join(supervisor, "dispatch-result.json");
  const result: ExecutionDispatchResult = {
    adapter: execution.adapter,
    status: execution.exitCode === 0 ? "completed" : "failed",
    // Trys šaltiniai eilės tvarka: adapterio priežastis, jo stdout, jo stderr. Tuščia santrauka
    // reikštų rezultatą be jokio pėdsako, iš kurio nebūtų ką diagnozuoti.
    summary: execution.reason || execution.stdout || execution.stderr,
    task_id: taskId,
    result_path: path.relative(root, resultPath).split(path.sep).join("/"),
  };
  await nodeFsAdapter.writeTextFile(resultPath, toPrettyJson(result));
  return result;
}
