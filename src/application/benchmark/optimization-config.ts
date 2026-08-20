// Užšaldytos optimizacijos benchmark konfigūracijos schema, hash'as ir keliai. Elgesio
// etalonas: AG_loop application/benchmark/capture-baseline.ts (konfigo pusė). VERQESTRA
// skirtumai: IO tik per portą; keliai — vq runtime šaknyje.

import path from "node:path";
import { z } from "zod";
import { sha256Hex } from "../../shared/hash.js";
import { canonicalJsonStringify } from "../../shared/json.js";
import { parseWithSchema } from "../../shared/schema.js";

/**
 * Baseline capture IO portas — sąmoningai `ContextPackFileSystemPort` poaibis, kad vienas
 * E4 fs adapteris struktūriškai dengtų abu kontraktus.
 */
export type BenchmarkCaptureFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};

const benchmarkCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "case id must be kebab-case"),
  category: z.string().min(1),
  description: z.string().min(1),
  size_class: z.enum(["small", "medium", "large"]),
  task_id_patterns: z.array(z.string().min(1)).min(1),
  min_tasks: z.number().int().positive().default(1),
});

export const optimizationBenchmarkConfigSchema = z
  .strictObject({
    version: z.number().int().positive(),
    frozen_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    spec_source: z.string().min(1),
    primary_metric: z.literal("tokens_per_verified_accepted_change"),
    token_basis: z.literal("total_tokens"),
    comparison: z.strictObject({
      max_token_regression_pct: z.number().positive().max(100),
      require_same_config_hash: z.literal(true),
      require_clean_integrity: z.boolean().default(true),
    }),
    cases: z.array(benchmarkCaseSchema).min(1),
    frozen_hash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((config, ctx) => {
    const duplicateIds = duplicates(config.cases.map((benchmarkCase) => benchmarkCase.id));
    if (duplicateIds.length > 0) {
      ctx.addIssue({ code: "custom", message: `duplicate benchmark case id(s): ${duplicateIds.join(", ")}` });
    }
    const duplicateCategories = duplicates(config.cases.map((benchmarkCase) => benchmarkCase.category));
    if (duplicateCategories.length > 0) {
      ctx.addIssue({ code: "custom", message: `duplicate benchmark case category(s): ${duplicateCategories.join(", ")}` });
    }
  });

export type OptimizationBenchmarkConfig = z.infer<typeof optimizationBenchmarkConfigSchema>;

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * Užšaldytos benchmark apibrėžties tapatybė. `frozen_hash` išimamas iš savo paties įvesties,
 * kad deklaruota reikšmė galėtų būti įrašyta tame pačiame faile, kurį aprašo. Du run'ai
 * palyginami tik kai šis hash'as sutampa — žr. `compareBenchmarkRuns`.
 */
export function frozenBenchmarkConfigHash(config: OptimizationBenchmarkConfig): string {
  const { frozen_hash: _ignored, ...rest } = config;
  return `sha256:${sha256Hex(canonicalJsonStringify(rest))}`;
}

/**
 * Trūkstama benchmark konfigūracija yra klaida, niekada tylus default'as: numanomas
 * fallback konfigas pagamintų hash'ą, kurio niekas neužšaldė, ir kiekvieną vėlesnį
 * palyginimą padarytų beprasmį.
 */
export async function loadOptimizationBenchmarkConfig(
  fs: BenchmarkCaptureFsPort,
  configPath: string,
): Promise<{ config: OptimizationBenchmarkConfig; hash: string }> {
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    throw new Error(`optimization-benchmark config not found: ${configPath}`);
  }
  const config = parseWithSchema(optimizationBenchmarkConfigSchema, JSON.parse(raw), "optimization-benchmark.json");
  const hash = frozenBenchmarkConfigHash(config);
  if (config.frozen_hash && config.frozen_hash !== hash) {
    throw new Error(`optimization-benchmark config frozen_hash mismatch: computed ${hash}, declared ${config.frozen_hash}`);
  }
  return { config, hash };
}

export type BenchmarkPaths = {
  configPath: string;
  usageLogPath: string;
  eventsLogPath: string;
  baselinePath: string;
  finalReportPath: string;
};

/** Kanoniniai artefaktų keliai VERQESTRA runtime šaknyje (vq/…). */
export function benchmarkPaths(runtimeRoot: string): BenchmarkPaths {
  return {
    configPath: path.join(runtimeRoot, "config", "optimization-benchmark.json"),
    usageLogPath: path.join(runtimeRoot, "logs", "token-usage.jsonl"),
    eventsLogPath: path.join(runtimeRoot, "logs", "task-events.jsonl"),
    baselinePath: path.join(runtimeRoot, "project", "optimization-baseline.md"),
    finalReportPath: path.join(runtimeRoot, "project", "optimization-final-report.md"),
  };
}
