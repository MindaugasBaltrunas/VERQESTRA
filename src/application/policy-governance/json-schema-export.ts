// JSON schemų eksportas konfigų kontraktams (etalonas: AG_loop core/schema-export.ts,
// WBR VQ-501 3/5-a). Schemų VARDAI ir `$id`/`title` — DUOMENYS, laikomi 1:1 su etalonu
// (`ag://schemas/*`, „AG ..."): juos vartoja išoriniai įrankiai, tad pervadinimas būtų
// kontrakto lūžis. IO — per portą; numatytasis output katalogas —
// `vq/generated/json-schema` (VERQESTRA runtime šaknis; etalone — `AG/generated/`).
//
// NUKRYPIMAS NUO ETALONO (2026-09-05 pilnas auditas, PG-4): `preflight-limits` ir
// `context-budget` schemų TURINYS nebeperrašomas ranka — jis generuojamas iš tų pačių zod
// objektų, kuriuos vykdo loader'iai ({@link preflightLimitsFileSchema},
// {@link contextBudgetSchema}). Antra ranka rašyta kopija buvo nusidriftavusi į priešingą
// verdiktą: eksportas reikalavo keturių `preflight-limits` raktų ir leido bet kokius
// papildomus, o loader'is (`z.strictObject`, visi optional) elgėsi atvirkščiai ir nė
// nemini `turnLimits`/`fastPath`/`llmMaxTurns`/`dispatchMaxTurns`/`maxSplitDepth`;
// `context-budget` eksportas reikalavo `max_context_chars`, kurį loader'is užpildo
// default'u. Operatorius, validuojantis konfigą pagal eksportuotą schemą, gaudavo kitą
// atsakymą nei realus kelias. Kryptis griežtinanti: eksportas dabar negali nutolti.

import path from "node:path";
import { z } from "zod";
import { toPosixPath } from "../../shared/paths.js";
import { contextBudgetSchema } from "./context-budget.js";
import { preflightLimitsFileSchema } from "./preflight-limits-policy.js";

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

/**
 * Loader'io zod objektas → eksportuojamas JSON Schema dokumentas.
 *
 * `io: "input"` yra esminis: numatytoji zod reikšmė („output") laiko `.default()` lauką
 * PRIVALOMU (po parse jis visada yra), tad `context-budget` atsidurtų su `required` visiems
 * keturiems raktams — būtent ta klaida, kurią čia taisome. Įvesties pusėje `.default()`
 * laukas yra optional su `default` reikšme, t. y. tiksliai tai, ką priima loader'is.
 *
 * `additionalProperties` normalizuojamas į `boolean`, nes {@link JsonSchemaDocument} yra
 * šio modulio viešas kontraktas (jį rendina CLI) — zod loose objektui grąžina `{}`.
 */
function jsonSchemaFromZod(schema: z.ZodType, $id: string, title: string): JsonSchemaDocument {
  const generated = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  const required = generated["required"];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id,
    title,
    type: "object",
    additionalProperties: generated["additionalProperties"] !== false,
    ...(Array.isArray(required) && required.length > 0 ? { required: required as string[] } : {}),
    properties: (generated["properties"] ?? {}) as Record<string, unknown>,
  };
}

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
  "context-budget": jsonSchemaFromZod(contextBudgetSchema, "ag://schemas/context-budget.json", "AG Context Budget"),
  "preflight-limits": jsonSchemaFromZod(
    preflightLimitsFileSchema,
    "ag://schemas/preflight-limits.json",
    "AG Preflight Limits",
  ),
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
