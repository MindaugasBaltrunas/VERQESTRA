// Task klasifikacijos TAISYKLĖ: kategorijos iš keyword/scope-path signalų, jautrumo ir
// modelio pakopos agregacija. Visos istorinės token-audito pamokos (2026-07-29 bare
// keyword'ai kėlė 32 % dispatch'ų į opus; 2026-08-06 substring pathIncludes dengė 36 %
// užduočių) užkoduotos segmentų ribų taisyklėje pathFragmentMatches — jos silpninti
// negalima. Defaults/parse gyvena task-classification-defaults.ts; config IO — E3.
// Behaviour etalon: AG_loop policy/task-classification.ts.

export type TaskCategory = "routine" | "feature" | "architecture" | "data" | "policy-sensitive" | "release";

export type TaskSensitivity = "low" | "medium" | "high";

export type TaskModelHint = "haiku" | "sonnet" | "opus";

export type TaskClassificationRule = {
  keywords: string[];
  pathIncludes: string[];
  sensitivity: TaskSensitivity;
  modelPolicyHint: TaskModelHint;
  reviewRoutingHint: string;
};

export type TaskClassificationPolicy = {
  version: string;
  categories: Record<TaskCategory, TaskClassificationRule>;
};

export type TaskClassification = {
  categories: TaskCategory[];
  sensitivity: TaskSensitivity;
  model_policy_hint: TaskModelHint;
  review_routing_hints: string[];
  reasons: string[];
};

export const TASK_CATEGORY_ORDER: TaskCategory[] = ["routine", "feature", "architecture", "data", "policy-sensitive", "release"];
const sensitivityRank: Record<TaskSensitivity, number> = { low: 0, medium: 1, high: 2 };
const modelRank: Record<TaskModelHint, number> = { haiku: 0, sonnet: 1, opus: 2 };

/**
 * pathIncludes vertinami pagal REALŲ task scope (allowedFiles), ne laisvą tekstą —
 * task'as, kuris tik PAMINI migrations/ kelią, nebeklasifikuojamas kaip aukštos rizikos.
 * Be allowedFiles fallback'as lieka tekstas, kad scope neturintys task'ai nebūtų
 * nuklasifikuoti žemyn.
 */
export function classifyTask(
  taskText: string,
  allowedFiles: string[],
  policy: TaskClassificationPolicy,
): TaskClassification {
  const textHaystack = taskText.toLowerCase().replace(/\\/g, "/");
  const pathHaystack = allowedFiles.length > 0 ? allowedFiles.join("\n").toLowerCase().replace(/\\/g, "/") : textHaystack;
  const matched: TaskCategory[] = [];
  const reasons: string[] = [];

  for (const category of TASK_CATEGORY_ORDER) {
    const rule = policy.categories[category];
    const keyword = rule.keywords.find((value) => textHaystack.includes(value.toLowerCase()));
    const pathMatch = rule.pathIncludes.find((value) => pathFragmentMatches(pathHaystack, value));
    if (keyword || pathMatch) {
      matched.push(category);
      reasons.push(`${category}: ${keyword ? `keyword "${keyword}"` : `path "${pathMatch}"`}`);
    }
  }

  const categories = matched.length > 0 ? matched : (["routine"] as TaskCategory[]);
  const sensitivity = highest(categories.map((category) => policy.categories[category].sensitivity), sensitivityRank, "low");
  const model = highest(categories.map((category) => policy.categories[category].modelPolicyHint), modelRank, "haiku");
  const reviewHints = Array.from(new Set(categories.map((category) => policy.categories[category].reviewRoutingHint))).sort();

  return {
    categories,
    sensitivity,
    model_policy_hint: model,
    review_routing_hints: reviewHints,
    reasons: reasons.length > 0 ? reasons : ["routine: default classification"],
  };
}

/**
 * Ar `pathIncludes` fragmentas atitinka scope kelius PAGAL ŽODŽIO RIBAS: fragmentas
 * ribojasi ne-žodžio simboliu (`/`, `-`, `_`, `.`) arba eilutės kraštu. „security"
 * atitinka `security-policy.json` (brūkšnys — riba), bet NE `mysecurity.ts` (žodžio
 * vidurys); fragmentai su savo skirtuku (`src/commands/`, `.sql`, `/auth/`) ribos iš
 * tos pusės nereikalauja.
 */
export function pathFragmentMatches(pathHaystack: string, fragment: string): boolean {
  const needle = fragment.toLowerCase().replace(/\\/g, "/");
  if (!needle) return false;

  const isWordChar = (value: string) => /[a-z0-9]/.test(value);
  const needsLeftBoundary = isWordChar(needle[0] ?? "");
  const needsRightBoundary = isWordChar(needle[needle.length - 1] ?? "");

  let from = 0;
  for (;;) {
    const index = pathHaystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : (pathHaystack[index - 1] ?? "");
    const afterIndex = index + needle.length;
    const after = afterIndex >= pathHaystack.length ? "" : (pathHaystack[afterIndex] ?? "");
    const leftOk = !needsLeftBoundary || before === "" || !isWordChar(before);
    const rightOk = !needsRightBoundary || after === "" || !isWordChar(after);
    if (leftOk && rightOk) return true;
    from = index + 1;
  }
}

function highest<T extends string>(values: T[], rank: Record<T, number>, fallback: T): T {
  return values.slice().sort((a, b) => rank[b] - rank[a] || a.localeCompare(b))[0] ?? fallback;
}
