// Bendri zod parse helper'iai — klaidos formatas `<label> validation failed: <path>: <msg>`
// yra baitinis kontraktas (tą pačią formą ranka atkartoja domain/policies/compression
// features parseris, pin'intas compression-policy fixture). Behaviour etalon: AG_loop
// core/schema.ts parseWithSchema/validateWithSchema/formatZodErrors.

import type { z } from "zod";

export type SchemaValidation<T> = { ok: true; data: T } | { ok: false; errors: string[] };

export function validateWithSchema<T>(schema: z.ZodType<T>, value: unknown): SchemaValidation<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodErrors(result.error) };
}

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label = "value"): T {
  const result = validateWithSchema(schema, value);
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${label} validation failed: ${result.errors.join("; ")}`);
}

export function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}
