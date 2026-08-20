// Architektūros governance konfigas ir stack decision būsena (etalonas: AG_loop
// orchestrator/architecture/architecture-governance.ts, WBR VQ-501 3/5-e). Schema — zod
// prie modulio; IO — per ArchitectureStateFsPort. Keliai VERQESTRA layout'e:
// `vq/architecture/{governance.json,stack-decision.json}` (etalone — AG/architecture);
// default'ų TURINYJE deklaruojami keliai atitinkamai perrašyti į vq/architecture, kad
// `check` tikrintų tuos pačius failus, kuriuos `init` sukuria. Šablonų tekstai — 1:1.
//
// stackDecisionStateSchema čia lygiuota į domain/policies StackDecision tipą (language/
// framework PRIVALOMI nullable laukai) — etalono zod leido juos praleisti, bet VERQESTRA
// persist kelias visada rašo pilną matricos formą, tad griežtesnė schema yra to paties
// kontrakto užrašymas be optional dviprasmybės.

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import {
  shouldPersistStackDecision,
  type StackDecision,
} from "../../domain/policies/stack-decision.js";
import type { ArchitectureStateFsPort } from "./ports.js";

const nonEmptyString = z.string().trim().min(1);
const stringList = z.array(nonEmptyString);

const architectureGovernanceSchema = z
  .object({
    version: nonEmptyString,
    generated_from: nonEmptyString.default("AG core defaults"),
    adr: z
      .object({
        path: nonEmptyString,
        require_human_approval: z.boolean().default(true),
      })
      .passthrough(),
    modules: z
      .object({
        path: nonEmptyString,
        enforce_boundaries: z.boolean().default(true),
      })
      .passthrough(),
    dependency_rules: z
      .object({
        path: nonEmptyString,
        new_dependency_requires_spec: z.boolean().default(true),
        new_dependency_requires_human_review: z.boolean().default(true),
      })
      .passthrough(),
    api_contract: z
      .object({
        path: nonEmptyString,
        public_api_changes_require_spec: z.boolean().default(true),
      })
      .passthrough(),
    db_schema: z
      .object({
        path: nonEmptyString,
        migrations_require_human_review_before_execution: z.boolean().default(true),
      })
      .passthrough(),
    ui_routes: z
      .object({
        path: nonEmptyString,
        route_changes_require_contract_update: z.boolean().default(true),
      })
      .passthrough(),
    risk_policy: z
      .object({
        path: nonEmptyString,
        always_human_review: stringList.default([]),
      })
      .passthrough(),
    quality_policy: z
      .object({
        path: nonEmptyString,
        default_checks: stringList.default([]),
      })
      .passthrough(),
  })
  .passthrough();

export type ArchitectureGovernance = z.infer<typeof architectureGovernanceSchema>;

export type ArchitectureGovernanceInitResult = {
  configPath: string;
  created: string[];
  skipped: string[];
  governance: ArchitectureGovernance;
};

export type ArchitectureGovernanceCheckResult = {
  configPath: string;
  ok: boolean;
  missing: string[];
  governance?: ArchitectureGovernance;
};

const stackDecisionAlternativeSchema = z
  .object({
    label: nonEmptyString,
    reason: nonEmptyString,
    confidence: z.enum(["low", "medium", "high"]),
  })
  .passthrough();

export const stackDecisionStateSchema = z
  .object({
    selectedLanguage: nonEmptyString.nullable(),
    selectedFramework: nonEmptyString.nullable(),
    architectureStyle: nonEmptyString,
    inputSignals: stringList.default([]),
    alternativesConsidered: z.array(stackDecisionAlternativeSchema).default([]),
    confidence: z.enum(["low", "medium", "high"]),
    reason: nonEmptyString,
    humanReviewRequired: z.boolean().default(false),
  })
  .passthrough();

export function architectureDir(projectRoot: string): string {
  return path.join(projectRoot, "vq", "architecture");
}

export function architectureGovernancePath(projectRoot: string): string {
  return path.join(architectureDir(projectRoot), "governance.json");
}

export function stackDecisionStatePath(projectRoot: string): string {
  return path.join(architectureDir(projectRoot), "stack-decision.json");
}

/**
 * Persists a validated StackDecision to vq/architecture/stack-decision.json for downstream
 * task generation. Skips writing for explicit-without-inference decisions (shared predicate).
 */
export async function persistStackDecisionState(
  fs: ArchitectureStateFsPort,
  decision: StackDecision,
  projectRoot: string,
): Promise<{ persisted: boolean; path: string }> {
  const root = path.resolve(projectRoot);
  const filePath = stackDecisionStatePath(root);
  const validated = parseWithSchema(stackDecisionStateSchema, decision, "stack-decision");
  if (!shouldPersistStackDecision(validated)) {
    return { persisted: false, path: filePath };
  }
  await fs.writeTextFile(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return { persisted: true, path: filePath };
}

/**
 * Loads the persisted StackDecision state, or undefined if none was ever written
 * (e.g. explicit-without-inference decisions are never persisted). Validates on read.
 */
export async function loadStackDecisionState(
  fs: ArchitectureStateFsPort,
  projectRoot: string,
): Promise<StackDecision | undefined> {
  const filePath = stackDecisionStatePath(path.resolve(projectRoot));
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) {
    return undefined;
  }
  return parseWithSchema(stackDecisionStateSchema, JSON.parse(raw), filePath);
}

export function defaultArchitectureGovernance(): ArchitectureGovernance {
  return parseArchitectureGovernance({
    version: "1.0.0",
    generated_from: "AG core defaults",
    adr: { path: "vq/architecture/adr", require_human_approval: true },
    modules: { path: "vq/architecture/modules.md", enforce_boundaries: true },
    dependency_rules: {
      path: "vq/architecture/dependencies.md",
      new_dependency_requires_spec: true,
      new_dependency_requires_human_review: true,
    },
    api_contract: { path: "vq/architecture/api-contract.md", public_api_changes_require_spec: true },
    db_schema: { path: "vq/architecture/db-schema.md", migrations_require_human_review_before_execution: true },
    ui_routes: { path: "vq/architecture/ui-routes.md", route_changes_require_contract_update: true },
    risk_policy: {
      path: "vq/architecture/risk-policy.md",
      always_human_review: [
        "new dependencies without explicit spec approval",
        "database migrations before execution",
        "auth/security/payment/secrets/permissions/encryption changes after planning",
        "production deploys",
        "destructive data operations",
        "billing changes",
        "outbound user communication behavior",
        "learning memory policy changes",
      ],
    },
    quality_policy: {
      path: "vq/architecture/quality-policy.md",
      default_checks: ["npm run typecheck", "npm run test", "npm run build"],
    },
  });
}

export async function initArchitectureGovernance(
  fs: ArchitectureStateFsPort,
  projectRoot: string,
): Promise<ArchitectureGovernanceInitResult> {
  const root = path.resolve(projectRoot);
  const governance = defaultArchitectureGovernance();
  const created: string[] = [];
  const skipped: string[] = [];

  const files: Array<[string, string]> = [
    [architectureGovernancePath(root), `${JSON.stringify(governance, null, 2)}\n`],
    [path.join(architectureDir(root), "modules.md"), modulesTemplate()],
    [path.join(architectureDir(root), "dependencies.md"), dependenciesTemplate()],
    [path.join(architectureDir(root), "api-contract.md"), apiContractTemplate()],
    [path.join(architectureDir(root), "db-schema.md"), dbSchemaTemplate()],
    [path.join(architectureDir(root), "ui-routes.md"), uiRoutesTemplate()],
    [path.join(architectureDir(root), "risk-policy.md"), riskPolicyTemplate(governance)],
    [path.join(architectureDir(root), "quality-policy.md"), qualityPolicyTemplate(governance)],
    [path.join(architectureDir(root), "adr", "README.md"), adrReadmeTemplate()],
  ];

  for (const [filePath, content] of files) {
    if (await fs.exists(filePath)) {
      skipped.push(relative(root, filePath));
      continue;
    }
    await fs.writeTextFile(filePath, content);
    created.push(relative(root, filePath));
  }

  return { configPath: architectureGovernancePath(root), created, skipped, governance };
}

export async function loadArchitectureGovernance(
  fs: ArchitectureStateFsPort,
  projectRoot: string,
): Promise<ArchitectureGovernance> {
  const filePath = architectureGovernancePath(path.resolve(projectRoot));
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) {
    throw new Error(`architecture governance not found: ${filePath}`);
  }
  return parseArchitectureGovernance(JSON.parse(raw), filePath);
}

export async function checkArchitectureGovernance(
  fs: ArchitectureStateFsPort,
  projectRoot: string,
): Promise<ArchitectureGovernanceCheckResult> {
  const root = path.resolve(projectRoot);
  const configPath = architectureGovernancePath(root);
  if (!(await fs.exists(configPath))) {
    return { configPath, ok: false, missing: [relative(root, configPath)] };
  }

  const governance = await loadArchitectureGovernance(fs, root);
  const requiredPaths = governanceRequiredPaths(governance);
  const missing: string[] = [];
  for (const requiredPath of requiredPaths) {
    const absolute = path.resolve(root, requiredPath);
    if (!(await fs.exists(absolute))) missing.push(requiredPath);
  }

  return { configPath, ok: missing.length === 0, missing, governance };
}

export function parseArchitectureGovernance(value: unknown, label = "architecture governance"): ArchitectureGovernance {
  return parseWithSchema(architectureGovernanceSchema, value, label);
}

export function governanceRequiredPaths(governance: ArchitectureGovernance): string[] {
  return [
    governance.adr.path,
    governance.modules.path,
    governance.dependency_rules.path,
    governance.api_contract.path,
    governance.db_schema.path,
    governance.ui_routes.path,
    governance.risk_policy.path,
    governance.quality_policy.path,
  ];
}

function relative(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

function modulesTemplate(): string {
  return "# Architecture Modules\n\nDefine project modules, ownership, allowed dependencies, and boundary rules here.\n\n## Rules\n\n- One task must not cross module boundaries unless the task spec allows it.\n- Public contracts between modules must be documented before implementation.\n";
}

function dependenciesTemplate(): string {
  return "# Dependency Rules\n\nNew runtime dependencies require explicit spec approval and human-review by default.\n\n## Rules\n\n- Do not add dependencies only for convenience.\n- Prefer standard library or existing project dependencies when reasonable.\n- Dependency changes must explain purpose, risk, license, and affected runtime.\n";
}

function apiContractTemplate(): string {
  return "# API Contract\n\nDocument public APIs, routes, commands, schemas, and compatibility guarantees here.\n\n## Rules\n\n- Public API changes require a spec update.\n- Breaking changes require explicit migration notes.\n";
}

function dbSchemaTemplate(): string {
  return "# DB Schema Policy\n\nDocument database schema, migration rules, and data safety constraints here.\n\n## Rules\n\n- Migrations require human-review before execution.\n- Destructive migrations require explicit approval and rollback notes.\n";
}

function uiRoutesTemplate(): string {
  return "# UI Routes\n\nDocument UI routes, navigation ownership, and user-facing workflow constraints here.\n\n## Rules\n\n- Route changes require contract updates when navigation or permissions change.\n";
}

function riskPolicyTemplate(governance: ArchitectureGovernance): string {
  return `# Risk Policy\n\nThese change classes require human-review by default:\n\n${governance.risk_policy.always_human_review.map((item) => `- ${item}`).join("\n")}\n`;
}

function qualityPolicyTemplate(governance: ArchitectureGovernance): string {
  return `# Quality Policy\n\nDefault checks:\n\n${governance.quality_policy.default_checks.map((item) => `- \`${item}\``).join("\n")}\n`;
}

function adrReadmeTemplate(): string {
  return "# ADR\n\nArchitecture Decision Records live here. By default, AG proposes ADRs and waits for human approval before treating them as accepted.\n";
}
