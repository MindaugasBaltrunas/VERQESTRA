// Architektūros mazgo verifikacija (etalonas: AG_loop architecture/
// architecture-node-verifier.ts, WBR VQ-501 3/5-c). Grynos taisyklės — domain
// node-verification-rules (FQC-12); čia orkestracija per portus: failų egzistavimas/
// turinys per ArchitectureStateFsPort, sėkmės persistencija (status "done" + verified_at
// vienu rašymu — AOD-01 lifecycle point 1) per NodeProgressStorePort. Persist klaida
// tylima kaip etalone: progress.json ne visuose kvietimo kontekstuose egzistuoja,
// verified_at vis tiek grąžinamas.

import path from "node:path";
import type { ArchitectureGraph, ArchitectureProgress } from "../../domain/architecture/graph.js";
import {
  checkDownstreamContracts,
  contentExportsSymbol,
  evaluatePolicies,
  findForbiddenDistImports,
  isForbiddenPath,
  isTestFile,
  testCandidatesFor,
  type NodeVerificationPolicies,
} from "../../domain/architecture/node-verification-rules.js";
import type { ArchitectureStateFsPort, NodeProgressStorePort } from "./ports.js";

export type NodeVerificationResult = {
  passed: boolean;
  failures: string[];
  policy_warnings: string[];
  policy_blockers: string[];
  verified_at?: string;
};

export type VerifyNodePorts = {
  fs: ArchitectureStateFsPort;
  progress: NodeProgressStorePort;
  /** Testuojamas laikas; default — realus laikrodis. */
  nowIso?: () => string;
};

async function fileExportsSymbol(fs: ArchitectureStateFsPort, absPath: string, symbolName: string): Promise<boolean> {
  const content = await fs.readTextFileIfExists(absPath);
  if (content === undefined) return false;
  return contentExportsSymbol(content, symbolName);
}

export async function verifyNode(
  ports: VerifyNodePorts,
  nodeId: string,
  graph: ArchitectureGraph,
  progress: ArchitectureProgress,
  repoRoot: string,
  policies?: NodeVerificationPolicies,
  persistSuccess = true,
): Promise<NodeVerificationResult> {
  const failures: string[] = [];
  let policy_warnings: string[] = [];
  let policy_blockers: string[] = [];
  const nodeProgress = progress.nodes[nodeId];

  if (!nodeProgress) {
    return {
      passed: false,
      failures: [`Node "${nodeId}" not found in progress ledger.`],
      policy_warnings: [],
      policy_blockers: [],
    };
  }

  const implemented = nodeProgress.implemented_files;

  // 1. All implemented files must exist on disk
  for (const relPath of implemented) {
    if (!(await ports.fs.exists(path.join(repoRoot, relPath)))) {
      failures.push(`Implemented file does not exist: ${relPath}`);
    }
  }

  // 2. Public exports from interface contract must be satisfied
  const contract = nodeProgress.interface_contract;
  if (contract) {
    for (const exportName of contract.public_exports) {
      let found = false;
      for (const relPath of implemented) {
        if (await fileExportsSymbol(ports.fs, path.join(repoRoot, relPath), exportName)) {
          found = true;
          break;
        }
      }
      if (!found) {
        failures.push(`Required export "${exportName}" not found in implemented files.`);
      }
    }
  }

  // 3. Downstream edge targets must list nodeId in their upstream contracts (when set)
  failures.push(...checkDownstreamContracts(nodeId, graph, progress));

  // 4. At least one test file must exist on disk per source file
  for (const relPath of implemented) {
    if (isTestFile(relPath)) continue;
    let hasTest = false;
    for (const candidate of testCandidatesFor(relPath)) {
      if (await ports.fs.exists(path.join(repoRoot, candidate))) {
        hasTest = true;
        break;
      }
    }
    if (!hasTest) {
      failures.push(`No test file found for: ${relPath}`);
    }
  }

  // 5. Governance: no forbidden paths; no imports from dist
  for (const relPath of implemented) {
    if (isForbiddenPath(relPath)) {
      failures.push(`Implemented file violates forbidden path governance: ${relPath}`);
    }
    const content = await ports.fs.readTextFileIfExists(path.join(repoRoot, relPath));
    if (content === undefined) continue;
    for (const importPath of findForbiddenDistImports(content)) {
      failures.push(`File "${relPath}" imports from a forbidden dist path: "${importPath}"`);
    }
  }

  // Policy checks — PC-ARCH-02 (924-04) ir PC-CODING-01 (924-05) sprendimai galioja ir čia:
  // `architectureStyle.layers` bei `codingPrinciples` lygiai šioje funkcijoje SĄMONINGAI
  // neskaitomi (per-node verifikacija neturi code index'o importų briaunoms; layer patikra —
  // atskiras `ag code-index architecture-check` įrankis). Taisyklė gyvena domain
  // evaluatePolicies — žr. jos dokumentaciją.
  if (policies) {
    ({ policy_warnings, policy_blockers } = evaluatePolicies(nodeId, nodeProgress, policies));
  }

  const passed = failures.length === 0 && policy_blockers.length === 0;

  if (passed) {
    const verified_at = (ports.nowIso ?? (() => new Date().toISOString()))();
    if (persistSuccess) {
      try {
        // AOD-01 lifecycle point (1): a passing verification advances the node to
        // "done" so downstream nodes (which gate on upstream status === "done" in
        // getReadyNodes) can finally become ready. Persisted alongside verified_at
        // as a single write.
        await ports.progress.updateNodeProgress(nodeId, { status: "done", verified_at });
      } catch {
        // progress.json may not exist in all call contexts — verified_at is still returned
      }
    }
    return { passed: true, failures: [], policy_warnings, policy_blockers, verified_at };
  }

  return { passed: false, failures, policy_warnings, policy_blockers };
}
