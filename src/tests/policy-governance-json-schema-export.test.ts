// Pilnas auditas 2026-09-05, PG-4: eksportuojama JSON schema ir ją vykdantis loader'is
// privalo duoti TĄ PATĮ verdiktą. Anksčiau schema buvo rašoma antra ranka ir nusidriftavo į
// priešingybę (`preflight-limits`: eksportas — 4 privalomi raktai + bet kokie papildomi;
// loader'is — `z.strictObject`, visi optional). Šis testas yra round-trip: kiekvienam
// pavyzdžiui „ką priima eksportuota schema" lyginama su „ką priima loader'is per
// `parseWithSchema`". Jokio realaus FS.
import assert from "node:assert/strict";
import test from "node:test";
import type { z } from "zod";
import { parseWithSchema } from "../shared/schema.js";
import { contextBudgetSchema } from "../application/policy-governance/context-budget.js";
import { preflightLimitsFileSchema } from "../application/policy-governance/preflight-limits-policy.js";
import {
  exportedJsonSchemas,
  listExportedJsonSchemaNames,
  type JsonSchemaDocument,
} from "../application/policy-governance/json-schema-export.js";

type JsonSchemaNode = Record<string, unknown>;

/**
 * Minimalus JSON Schema vykdytojas — TIK tie raktažodžiai, kuriuos generuoja šių dviejų
 * konfigų zod objektai (`type`, `properties`, `required`, `additionalProperties`, `minimum`,
 * `exclusiveMinimum`, `minLength`). Tikslas nėra pilnas draft-2020-12: tikslas — patikrinti
 * eksportuotą dokumentą taip, kaip jį perskaitytų operatoriaus validatorius.
 */
function schemaRejects(node: JsonSchemaNode, value: unknown, at = "<root>"): string[] {
  const errors: string[] = [];
  const type = node["type"];

  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${at}: expected object`];
    }
    const record = value as Record<string, unknown>;
    const properties = (node["properties"] ?? {}) as Record<string, JsonSchemaNode | undefined>;
    const required = node["required"];
    for (const key of Array.isArray(required) ? (required as string[]) : []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) errors.push(`${at}.${key}: required`);
    }
    for (const [key, entry] of Object.entries(record)) {
      const child = properties[key];
      if (child) errors.push(...schemaRejects(child, entry, `${at}.${key}`));
      else if (node["additionalProperties"] === false) errors.push(`${at}.${key}: additional property`);
    }
    return errors;
  }

  if (type === "integer" && !Number.isInteger(value)) errors.push(`${at}: expected integer`);
  if (type === "number" && typeof value !== "number") errors.push(`${at}: expected number`);
  if (type === "boolean" && typeof value !== "boolean") errors.push(`${at}: expected boolean`);
  if (type === "string" && typeof value !== "string") errors.push(`${at}: expected string`);

  const minimum = node["minimum"];
  if (typeof minimum === "number" && typeof value === "number" && value < minimum) {
    errors.push(`${at}: below minimum ${minimum}`);
  }
  const exclusiveMinimum = node["exclusiveMinimum"];
  if (typeof exclusiveMinimum === "number" && typeof value === "number" && value <= exclusiveMinimum) {
    errors.push(`${at}: not above exclusiveMinimum ${exclusiveMinimum}`);
  }
  const minLength = node["minLength"];
  if (typeof minLength === "number" && typeof value === "string" && value.length < minLength) {
    errors.push(`${at}: shorter than ${minLength}`);
  }
  return errors;
}

function schemaAccepts(document: JsonSchemaDocument, value: unknown): boolean {
  return schemaRejects({ ...document }, value).length === 0;
}

function loaderAccepts(schema: z.ZodType, value: unknown): boolean {
  try {
    parseWithSchema(schema, value, "round-trip");
    return true;
  } catch {
    return false;
  }
}

function assertRoundTrip(document: JsonSchemaDocument, schema: z.ZodType, samples: { label: string; value: unknown }[]): void {
  for (const { label, value } of samples) {
    assert.equal(
      schemaAccepts(document, value),
      loaderAccepts(schema, value),
      `${label}: eksportuota schema ir loader'is nesutaria (${JSON.stringify(value)})`,
    );
  }
}

test("json-schema-export: schemų vardai ir tapatybės metaduomenys nekinta (išorinių įrankių kontraktas)", () => {
  assert.deepEqual(listExportedJsonSchemaNames(), [
    "context-budget",
    "context-pack",
    "model-policy",
    "preflight-limits",
    "project-profile",
  ]);

  for (const name of listExportedJsonSchemaNames()) {
    const document = exportedJsonSchemas[name]!;
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.equal(document.$id, `ag://schemas/${name}.json`, name);
    assert.equal(document.type, "object", name);
    assert.equal(typeof document.additionalProperties, "boolean", `${name}: additionalProperties privalo likti boolean`);
    assert.ok(document.title.startsWith("AG "), name);
  }
});

test("json-schema-export: preflight-limits schema atspindi loader'io strictObject (PG-4)", () => {
  const document = exportedJsonSchemas["preflight-limits"]!;

  // Loader'is yra `z.strictObject`, kuriame VISI raktai optional.
  assert.equal(document.additionalProperties, false, "nežinomas raktas privalo būti atmestas");
  assert.equal(document.required, undefined, "nė vienas raktas nėra privalomas");

  // Raktai, kurių ranka rašytas eksportas apskritai nemini.
  for (const key of ["turnLimits", "fastPath", "llmMaxTurns", "dispatchMaxTurns", "maxSplitDepth", "_comment"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(document.properties, key), `trūksta rakto: ${key}`);
  }

  assertRoundTrip(document, preflightLimitsFileSchema, [
    { label: "tuščias konfigas", value: {} },
    { label: "dalinis konfigas", value: { maxLines: 200 } },
    { label: "turnLimits lentelė", value: { turnLimits: { small: 10, semanticReview: 40 } } },
    { label: "nulinis opt-out", value: { llmMaxTurns: 0, dispatchMaxTurns: 0, maxSplitDepth: 0 } },
    { label: "boolean vėliavos", value: { autoOpenSpec: true, fastPath: false } },
    { label: "_comment", value: { _comment: "kodėl pakelta", maxDomains: 3 } },
    { label: "nežinomas raktas", value: { maxLines: 120, nesamasRaktas: 1 } },
    { label: "nulinė riba", value: { maxLines: 0 } },
    { label: "ne skaičius", value: { maxAllowedPaths: "aštuoni" } },
    { label: "trupmena", value: { maxActionBullets: 2.5 } },
    { label: "nulis turnLimits lentelėje", value: { turnLimits: { small: 0 } } },
    { label: "nežinomas turnLimits raktas", value: { turnLimits: { extraLarge: 10 } } },
    { label: "ne boolean vėliava", value: { fastPath: "taip" } },
  ]);
});

test("json-schema-export: context-budget schema atspindi loader'io default'us (PG-4)", () => {
  const document = exportedJsonSchemas["context-budget"]!;

  // Loader'is trūkstamą raktą užpildo default'u — vadinasi, privalomų raktų NĖRA.
  // (`io: "input"` yra tai, kas šią eilutę laiko teisingą: output pusėje zod `.default()`
  // laikytų raktą privalomu ir eksportas vėl meluotų.)
  assert.equal(document.required, undefined, "default'ą turintis raktas nėra privalomas");
  assert.equal(document.additionalProperties, true, "loader'is yra passthrough");

  assertRoundTrip(document, contextBudgetSchema, [
    { label: "tuščias konfigas", value: {} },
    { label: "vienas raktas", value: { max_context_chars: 5000 } },
    { label: "visi raktai", value: { max_context_chars: 9000, max_spec_fragments: 4, max_file_fragments: 4, max_files: 4 } },
    { label: "papildomas raktas", value: { max_files: 8, kitas: true } },
    { label: "nulis", value: { max_context_chars: 0 } },
    { label: "neigiamas", value: { max_files: -1 } },
    { label: "ne skaičius", value: { max_spec_fragments: "8" } },
    { label: "trupmena", value: { max_file_fragments: 1.5 } },
  ]);
});
