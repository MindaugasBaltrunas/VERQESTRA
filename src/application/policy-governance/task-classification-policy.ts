// Task klasifikacijos konfigo loaderis (etalono policy/task-classification.ts IO pusė,
// WBR VQ-305). Grynos taisyklės (classifyTask, parseTaskClassificationPolicy) ir default'ai
// gyvena domain/policies — čia tik failo skaitymas per portą.
//
// SVARBI etalono pamoka (2026-08-06 token auditas): pasenęs konfigo failas PERRAŠO kodo
// default'us — konfigas laimi prieš kodą. Trūkstamas failas → domain default'ai; esamas
// failas parse'inamas griežtai (bloga forma — klaida, ne tylus default'as).
import path from "node:path";
import type { TaskClassificationPolicy } from "../../domain/policies/task-classification.js";
import {
  defaultTaskClassificationPolicy,
  parseTaskClassificationPolicy,
} from "../../domain/policies/task-classification-defaults.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

export function taskClassificationPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "task-classification-policy.json");
}

export async function loadTaskClassificationPolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<TaskClassificationPolicy> {
  const configPath = taskClassificationPolicyPath(runtimeRoot);
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    return defaultTaskClassificationPolicy;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`task classification policy is not valid JSON: ${message}`, { cause: error });
  }
  return parseTaskClassificationPolicy(parsed, configPath);
}
