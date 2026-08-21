// `learning` CLI adapteris (etalonas: interfaces/cli/learning/index.ts 1:1). Atmintis —
// application/learning/learning-memory per LearningFsPort (keliai vq/state/learning);
// čia lieka argumentų parsinimas ir etalono console eilutės. Etalono exactOptional
// skirtumas: query/record laukai perduodami sąlyginiais spread'ais.

import {
  appendLearningMemoryRecord,
  decideLearningRecommendation,
  queryLearningMemory,
  summarizeLearningMemory,
  type LearningMemoryEventType,
} from "../../../application/learning/learning-memory.js";
import type { LearningFsPort } from "../../../application/learning/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type LearningCommandDeps = {
  fs: LearningFsPort;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
  io?: CliIo;
};

export async function learningCommand(deps: LearningCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const command = args.find((arg) => !arg.startsWith("--")) ?? "summary";
    const asJson = args.includes("--json");

    if (command === "record") {
      const type = requiredArg(args, "--type") as LearningMemoryEventType;
      const summary = requiredArg(args, "--summary");
      const taskId = argValue(args, "--task-id");
      const file = argValue(args, "--file");
      const record = await appendLearningMemoryRecord(deps.fs, deps.runtimeRoot, {
        type,
        summary,
        ...(taskId === undefined ? {} : { task_id: taskId }),
        ...(file === undefined ? {} : { file }),
        labels: argValues(args, "--label"),
        evidence: argValues(args, "--evidence"),
      });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`learning_record: ${record.id}`);
      return 0;
    }

    if (command === "query") {
      const taskId = argValue(args, "--task-id");
      const file = argValue(args, "--file");
      const type = argValue(args, "--type") as LearningMemoryEventType | undefined;
      const label = argValue(args, "--label");
      const limit = parseLimit(argValue(args, "--limit"));
      const records = await queryLearningMemory(deps.fs, deps.runtimeRoot, {
        ...(taskId === undefined ? {} : { taskId }),
        ...(file === undefined ? {} : { file }),
        ...(type === undefined ? {} : { type }),
        ...(label === undefined ? {} : { label }),
        ...(limit === undefined ? {} : { limit }),
      });
      if (asJson) {
        io.out(JSON.stringify(records, null, 2));
        return 0;
      }
      for (const record of records) io.out(`${record.ts} ${record.type} ${record.id}: ${record.summary}`);
      return 0;
    }

    if (command === "summary") {
      const summary = await summarizeLearningMemory(deps.fs, deps.runtimeRoot);
      if (asJson) {
        io.out(JSON.stringify(summary, null, 2));
        return 0;
      }
      io.out(`records: ${summary.records}`);
      io.out(`task_outcome: ${summary.by_type.task_outcome}`);
      io.out(`failure_pattern: ${summary.by_type.failure_pattern}`);
      io.out(`context_feedback: ${summary.by_type.context_feedback}`);
      io.out(`policy_recommendation: ${summary.by_type.policy_recommendation}`);
      io.out(`pending_recommendations: ${summary.pending_recommendations}`);
      io.out(`approved_recommendations: ${summary.approved_recommendations}`);
      io.out(`rejected_recommendations: ${summary.rejected_recommendations}`);
      return 0;
    }

    if (command === "approve" || command === "reject") {
      const id = positionalAfter(args, command);
      if (!id) throw new Error(`Usage: verqestra learning ${command} <recommendation-id> [--evidence <text>] [--json]`);
      const record = await decideLearningRecommendation(
        deps.fs,
        deps.runtimeRoot,
        id,
        command === "approve" ? "approved" : "rejected",
        argValues(args, "--evidence"),
      );
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`learning_recommendation_${record.recommendation_status}: ${record.id}`);
      return 0;
    }

    throw new Error("Usage: verqestra learning [record|query|summary|approve|reject] [--json]");
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}

function requiredArg(args: string[], flag: string): string {
  const value = argValue(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function argValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const next = args[index + 1];
    if (args[index] === flag && next) values.push(next);
  }
  return values;
}

function positionalAfter(args: string[], command: string): string | undefined {
  const index = args.indexOf(command);
  if (index < 0) return undefined;
  return args.slice(index + 1).find((arg) => !arg.startsWith("--"));
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
