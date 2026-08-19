// Benchmark case'ų priskyrimo taisyklės: šaldyto konfigo case apibrėžimas ir glob-lite
// task-id atitikimas. Pure. Behaviour etalon: AG_loop domain/metrics/accepted-change.ts
// (cases pusė; WBR VQ-204 skaidymas).

export type BenchmarkCaseDefinition = {
  id: string;
  category: string;
  description: string;
  size_class: "small" | "medium" | "large";
  task_id_patterns: string[];
  min_tasks: number;
};

/** Glob-lite matcher: `*` matches any run of characters (including none); everything else is literal. */
export function matchesTaskIdPattern(taskId: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(taskId);
}

export function matchingCaseIds(taskId: string, cases: BenchmarkCaseDefinition[]): string[] {
  return cases
    .filter((definition) => definition.task_id_patterns.some((pattern) => matchesTaskIdPattern(taskId, pattern)))
    .map((definition) => definition.id);
}

/** First match in configuration order wins; ambiguity is reported separately by the caller. */
export function assignTaskToCase(taskId: string, cases: BenchmarkCaseDefinition[]): BenchmarkCaseDefinition | null {
  return (
    cases.find((definition) => definition.task_id_patterns.some((pattern) => matchesTaskIdPattern(taskId, pattern))) ??
    null
  );
}
