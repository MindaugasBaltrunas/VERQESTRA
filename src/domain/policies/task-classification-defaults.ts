// Task klasifikacijos DEFAULTS + parse. Atskirta nuo taisyklės (WBR VQ-203 / AG_loop R8):
// pathIncludes fragmentai yra PROJEKTO SEED duomenys, ne taisyklė — VERQESTRA projektas
// juos perrašo savo konfige; čia laikoma etalono kopija su visomis token-audito
// anotacijomis. Config failo IO (loadTaskClassificationPolicy) — E3 sluoksnyje.
// Behaviour etalon: AG_loop policy/task-classification.ts defaults/parse pusė.

import {
  TASK_CATEGORY_ORDER,
  type TaskCategory,
  type TaskClassificationPolicy,
  type TaskClassificationRule,
} from "./task-classification.js";

export const defaultTaskClassificationPolicy: TaskClassificationPolicy = {
  version: "1.0.0",
  categories: {
    routine: {
      keywords: ["fix typo", "docs", "readme", "test", "refactor"],
      pathIncludes: ["README.md", "docs/", "tests/"],
      sensitivity: "low",
      modelPolicyHint: "haiku",
      reviewRoutingHint: "standard-review",
    },
    feature: {
      keywords: ["feature", "add", "implement", "ui", "command", "api"],
      pathIncludes: ["src/commands/", "src/orchestrator/", "apps/", "packages/", "modules/", "workers/", "AG/config/"],
      sensitivity: "medium",
      modelPolicyHint: "sonnet",
      reviewRoutingHint: "feature-review",
    },
    architecture: {
      keywords: ["architecture", "boundary", "isolation", "dependency"],
      pathIncludes: ["AG/orchestrator/src/core/", "architecture"],
      sensitivity: "high",
      modelPolicyHint: "opus",
      reviewRoutingHint: "architecture-review",
    },
    // 2026-07-29/2026-08-06 token auditai: bare raktažodžiai ir substring pathIncludes
    // kėlė eilines užduotis į opus (36 % aprėptis). Aukštos rizikos kategorijos
    // signalizuojamos tik nedviprasmiškais terminais/keliais; realią DB/security/dependency
    // riziką nepriklausomai dengia human-review vartai, vykdomi PRIEŠ klasifikaciją.
    data: {
      keywords: ["migration", "database", "postgres"],
      pathIncludes: ["migrations/", "schema.prisma", "/db/", "database/", ".sql"],
      sensitivity: "high",
      modelPolicyHint: "opus",
      reviewRoutingHint: "data-review",
    },
    "policy-sensitive": {
      keywords: ["policy", "security", "permission", "secret", "approval"],
      // „policy" kaip kelio fragmentas pašalintas: jis atitiko visą policy sluoksnį.
      pathIncludes: ["security", "permission", "approval", "/auth/"],
      sensitivity: "high",
      modelPolicyHint: "opus",
      reviewRoutingHint: "policy-review",
    },
    release: {
      keywords: ["release", "publish"],
      // `package.json` pašalintas: kiekvienas naujas workspace paketas jį liečia.
      pathIncludes: [".github/workflows/", "docs/release", "templates/VERSION"],
      sensitivity: "high",
      modelPolicyHint: "opus",
      reviewRoutingHint: "release-review",
    },
  },
};

export function parseTaskClassificationPolicy(value: unknown, label = "task classification policy"): TaskClassificationPolicy {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid ${label}: expected object`);
  }
  const candidate = value as Partial<TaskClassificationPolicy>;
  if (typeof candidate.version !== "string" || !candidate.version.trim()) {
    throw new Error(`Invalid ${label}: version is required`);
  }
  if (!candidate.categories || typeof candidate.categories !== "object") {
    throw new Error(`Invalid ${label}: categories are required`);
  }

  const categories = {} as Record<TaskCategory, TaskClassificationRule>;
  for (const category of TASK_CATEGORY_ORDER) {
    const rule = (candidate.categories as Partial<Record<TaskCategory, Partial<TaskClassificationRule>>>)[category];
    if (!rule) throw new Error(`Invalid ${label}: missing category ${category}`);
    categories[category] = parseRule(rule, `${label}.${category}`);
  }
  return { version: candidate.version, categories };
}

function parseRule(value: Partial<TaskClassificationRule>, label: string): TaskClassificationRule {
  if (!Array.isArray(value.keywords) || !value.keywords.every((item) => typeof item === "string")) {
    throw new Error(`Invalid ${label}: keywords must be strings`);
  }
  if (!Array.isArray(value.pathIncludes) || !value.pathIncludes.every((item) => typeof item === "string")) {
    throw new Error(`Invalid ${label}: pathIncludes must be strings`);
  }
  if (value.sensitivity !== "low" && value.sensitivity !== "medium" && value.sensitivity !== "high") {
    throw new Error(`Invalid ${label}: sensitivity is invalid`);
  }
  if (value.modelPolicyHint !== "haiku" && value.modelPolicyHint !== "sonnet" && value.modelPolicyHint !== "opus") {
    throw new Error(`Invalid ${label}: modelPolicyHint is invalid`);
  }
  if (typeof value.reviewRoutingHint !== "string" || !value.reviewRoutingHint.trim()) {
    throw new Error(`Invalid ${label}: reviewRoutingHint is required`);
  }
  return {
    keywords: value.keywords,
    pathIncludes: value.pathIncludes,
    sensitivity: value.sensitivity,
    modelPolicyHint: value.modelPolicyHint,
    reviewRoutingHint: value.reviewRoutingHint,
  };
}
