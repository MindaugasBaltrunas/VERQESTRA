// JSON schemų eksportas konfigų kontraktams (etalonas: AG_loop core/schema-export.ts,
// WBR VQ-501 3/5-a). Schemų turinys — DUOMENYS, laikomi 1:1 su etalonu (įskaitant
// `ag://schemas/*` $id ir „AG ..." pavadinimus) — juos vartoja išoriniai įrankiai, tad
// pervadinimas būtų kontrakto lūžis. IO — per portą; numatytasis output katalogas —
// `vq/generated/json-schema` (VERQESTRA runtime šaknis; etalone — `AG/generated/`).

import path from "node:path";
import { toPosixPath } from "../../shared/paths.js";

export type JsonSchemaDocument = {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $id: string;
  title: string;
  type: "object";
  additionalProperties: boolean;
  required?: string[];
  properties: Record<string, unknown>;
};

export type JsonSchemaExportResult = {
  outputDir: string;
  files: string[];
};

export type JsonSchemaExportPorts = {
  /** Sukuria tėvinius katalogus ir įrašo tekstą (etalono mkdir recursive + writeFile). */
  writeTextFile(absolutePath: string, text: string): Promise<void>;
};

const nonEmptyString = { type: "string", minLength: 1 };
const stringArray = { type: "array", items: nonEmptyString };
const positiveInteger = { type: "integer", minimum: 1 };

export const exportedJsonSchemas: Record<string, JsonSchemaDocument> = {
  "project-profile": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ag://schemas/project-profile.json",
    title: "AG Project Profile",
    type: "object",
    additionalProperties: true,
    required: ["name", "mode"],
    properties: {
      name: nonEmptyString,
      mode: nonEmptyString,
      language: nonEmptyString,
      package_manager: nonEmptyString,
      stack: { type: "object", additionalProperties: true },
      source_roots: stringArray,
      forbidden_paths: stringArray,
      quality_gates: {
        type: "object",
        additionalProperties: nonEmptyString,
      },
    },
  },
  "model-policy": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ag://schemas/model-policy.json",
    title: "AG Model Policy",
    type: "object",
    additionalProperties: true,
    required: ["tiers"],
    properties: {
      tiers: stringArray,
      compound_project: {
        type: "object",
        additionalProperties: nonEmptyString,
      },
      escalation: {
        type: "object",
        additionalProperties: true,
        properties: {
          on_retry: { type: "boolean" },
          max_tier: nonEmptyString,
        },
      },
    },
  },
  "context-budget": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ag://schemas/context-budget.json",
    title: "AG Context Budget",
    type: "object",
    additionalProperties: true,
    required: ["max_context_chars"],
    properties: {
      max_context_chars: positiveInteger,
      max_spec_fragments: positiveInteger,
      max_file_fragments: positiveInteger,
      max_files: positiveInteger,
    },
  },
  "preflight-limits": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ag://schemas/preflight-limits.json",
    title: "AG Preflight Limits",
    type: "object",
    additionalProperties: true,
    required: ["maxLines", "maxAllowedPaths", "maxDomains", "maxActionBullets"],
    properties: {
      maxLines: positiveInteger,
      maxAllowedPaths: positiveInteger,
      maxDomains: positiveInteger,
      maxActionBullets: positiveInteger,
      autoOpenSpec: { type: "boolean" },
    },
  },
  "context-pack": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ag://schemas/context-pack.json",
    title: "AG Context Pack",
    type: "object",
    additionalProperties: true,
    required: ["task_id", "phase", "goal", "allowed_paths"],
    properties: {
      task_id: nonEmptyString,
      phase: nonEmptyString,
      goal: nonEmptyString,
      allowed_paths: stringArray,
      spec_fragments: stringArray,
      architecture_rules: stringArray,
      checks: stringArray,
      budget: {
        type: "object",
        additionalProperties: true,
        properties: {
          max_context_chars: positiveInteger,
          max_llm_calls: positiveInteger,
          browser: { type: "boolean" },
          scraper: { type: "boolean" },
          mcp: { type: "boolean" },
        },
      },
    },
  },
};

export function listExportedJsonSchemaNames(): string[] {
  return Object.keys(exportedJsonSchemas).sort();
}

export async function exportJsonSchemas(
  ports: JsonSchemaExportPorts,
  projectRoot: string,
  outputDir?: string,
): Promise<JsonSchemaExportResult> {
  const root = path.resolve(projectRoot);
  const targetDir = outputDir ?? path.join(root, "vq", "generated", "json-schema");

  const files: string[] = [];
  for (const name of listExportedJsonSchemaNames()) {
    const filePath = path.join(targetDir, `${name}.schema.json`);
    await ports.writeTextFile(filePath, `${stableJson(exportedJsonSchemas[name]!)}\n`);
    files.push(toPosixPath(path.relative(root, filePath)));
  }

  return {
    outputDir: toPosixPath(path.relative(root, targetDir)),
    files,
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
