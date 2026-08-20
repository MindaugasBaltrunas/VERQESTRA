// `code-index` CLI adapteris (etalonas: interfaces/cli/code-index/index.ts). Build/
// freshness/boundary logika — application/code-intelligence; architektūros stiliaus
// politika — application/policy-governance (etalono loadArchitectureStylePolicy(agRootPath)
// atitikmuo — runtimeRoot=`<root>/vq`). Console eilutės ir exit kodai — etalonas 1:1.

import path from "node:path";
import { buildCodeIndex } from "../../../application/code-intelligence/indexing/builder.js";
import { findArchitectureBoundaryViolations } from "../../../application/code-intelligence/boundary/architecture-boundary.js";
import {
  checkCodeIndexFreshness,
  readCodeIndex,
} from "../../../application/code-intelligence/store/code-index-store.js";
import type { CodeIntelligenceFileSystemPort } from "../../../application/code-intelligence/ports.js";
import { loadArchitectureStylePolicy } from "../../../application/policy-governance/architecture-policies.js";
import type { PolicyConfigFileSystemPort } from "../../../application/policy-governance/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type CodeIndexCommandDeps = {
  codeFs: CodeIntelligenceFileSystemPort;
  policyFs: PolicyConfigFileSystemPort;
  projectRoot: string;
  /** Numatytoji runtime šaknis — `<projectRoot>/vq`. */
  runtimeRoot?: string;
  io?: CliIo;
};

export async function codeIndexCommand(deps: CodeIndexCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const subcommand = args[0] ?? "build";
    if (subcommand === "build") {
      const data = await buildCodeIndex(deps.codeFs, deps.projectRoot);
      io.out(`code-index: built`);
      io.out(`files: ${data.manifest.file_count}`);
      io.out(`symbols: ${data.manifest.symbol_count}`);
      io.out(`edges: ${data.manifest.edge_count}`);
      return 0;
    }

    if (subcommand === "check") {
      const freshness = await checkCodeIndexFreshness(deps.codeFs, deps.projectRoot);
      if (freshness.ok) {
        io.out(`code-index: fresh`);
        io.out(`files: ${freshness.manifest.file_count}`);
        return 0;
      }
      io.error(`code-index: stale (${freshness.reason})`);
      return 1;
    }

    if (subcommand === "architecture-check") {
      return await printArchitectureBoundaryCheck(deps, io);
    }

    io.error("Usage: ag code-index [build|check|architecture-check]");
    return 2;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function printArchitectureBoundaryCheck(deps: CodeIndexCommandDeps, io: CliIo): Promise<number> {
  const freshness = await checkCodeIndexFreshness(deps.codeFs, deps.projectRoot);
  if (!freshness.ok) {
    io.error(`code-index: stale (${freshness.reason})`);
    return 1;
  }

  const index = await readCodeIndex(deps.codeFs, deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(deps.projectRoot, "vq");
  const policy = await loadArchitectureStylePolicy(deps.policyFs, runtimeRoot);
  const violations = findArchitectureBoundaryViolations(index, policy);

  if (violations.length === 0) {
    io.out(`architecture-check: 0 violations`);
    return 0;
  }

  io.out(`architecture-check: ${violations.length} violation(s)`);
  for (const violation of violations) {
    io.out(
      `forbidden: "${violation.from}" (${violation.fromLayer}) -> "${violation.to}" (${violation.toLayer}) [${violation.dependency}]`,
    );
  }
  return 1;
}
