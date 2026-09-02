// Pure architecture node-verification rules. Low domain layer: no fs/path/node:fs/process
// imports and no side effects — only the total functions and pattern constants that decide
// whether a node's already-loaded files, contracts and policies satisfy verification. The
// fs-bound verifier (E3/E4) reads disk state and delegates every rule here, then keeps its
// own progress-ledger writes. Behaviour etalon: AG_loop domain/architecture/
// node-verification-rules.ts; WBR VQ-204 inversija: vietoj core/schema zod tipų — domain
// policy-view tipai (vėlesnio sluoksnio schema juos TENKINA), path helper'iai — path-lite.

import { dirOf, baseOf, splitExt, normalizeSlashes } from "./path-lite.js";
import { detectForbiddenDependencyViolations } from "../policies/architecture-style.js";
import type { ArchitectureGraph, ArchitectureNodeProgress, ArchitectureProgress } from "./graph.js";

/** Domain view: laukai, kuriuos verifikacija realiai skaito + passthrough likusiems. */
export type ArchitectureStyleVerificationView = {
  strictness: string;
  forbidden_dependencies: string[];
} & Record<string, unknown>;

/** Domain view: vienintelis skaitomas enforcement laukas + passthrough. */
export type EnforcementPolicyView = {
  require_interface_contract_for_public_changes: boolean;
} & Record<string, unknown>;

/** Priimama dėl schemos pilnumo, SĄMONINGAI neskaitoma — žr. evaluatePolicies pastabą. */
export type CodingPrinciplesPolicyView = Record<string, unknown>;

/** Repo-relative path fragments an implemented file may never live under. */
export const FORBIDDEN_PATTERNS: RegExp[] = [
  /(?:^|[/\\])node_modules(?:[/\\]|$)/,
  /(?:^|[/\\])dist(?:[/\\]|$)/,
  /(?:^|[/\\])\.env(?:\.|$)/,
];

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Verification rules -----------------------------------------------------

/** True when a path already denotes a test/spec file (skipped by the test-coverage rule). */
export function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath);
}

/**
 * Candidate repo-relative locations of a source file's test, as forward-slash strings. The
 * caller must resolve each against the repo root (path.join(repoRoot, candidate)); the `..`
 * segments are left unresolved on purpose so that join step normalizes them identically to the
 * previous inline implementation.
 */
export function testCandidatesFor(relPath: string): string[] {
  const { base, ext } = splitExt(baseOf(relPath));
  const dir = dirOf(relPath);
  return [
    `${dir}/${base}.test${ext}`,
    `${dir}/${base}.spec${ext}`,
    `${dir}/__tests__/${base}.test${ext}`,
    `${dir}/tests/${base}.test${ext}`,
    `${dir}/../tests/${base}.test${ext}`,
    `${dir}/../__tests__/${base}.test${ext}`,
  ];
}

/** True when a repo-relative implemented file violates forbidden-path governance. */
export function isForbiddenPath(relPath: string): boolean {
  const normalized = normalizeSlashes(relPath);
  return FORBIDDEN_PATTERNS.some((p) => p.test(normalized));
}

/** Extract every `import ... from "..."` specifier in `content` that points into a dist/ path. */
export function findForbiddenDistImports(content: string): string[] {
  const importRegex = /^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm;
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    const importPath = m[1];
    if (importPath !== undefined && /(?:^|\/)dist\//.test(importPath)) {
      hits.push(importPath);
    }
  }
  return hits;
}

/** True when already-read file `content` publicly exports `symbolName`. */
export function contentExportsSymbol(content: string, symbolName: string): boolean {
  const escaped = escapeRegex(symbolName);
  return [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`export\\s+(?:const|let|var|class|type|interface|enum|abstract\\s+class)\\s+${escaped}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
    new RegExp(`export\\s+default\\s+${escaped}\\b`),
  ].some((p) => p.test(content));
}

/**
 * Downstream-contract rule: every edge target that declares an interface_contract must list
 * `nodeId` among its upstream nodes. Returns one failure message per violating downstream node.
 */
export function checkDownstreamContracts(
  nodeId: string,
  graph: ArchitectureGraph,
  progress: ArchitectureProgress,
): string[] {
  const failures: string[] = [];
  for (const edge of graph.edges.filter((e) => e.from === nodeId)) {
    const ds = progress.nodes[edge.to];
    if (ds?.interface_contract && !ds.interface_contract.upstream.includes(nodeId)) {
      failures.push(`Downstream node "${edge.to}" contract does not list "${nodeId}" as upstream.`);
    }
  }
  return failures;
}

export type NodeVerificationPolicies = {
  architectureStyle: ArchitectureStyleVerificationView;
  codingPrinciples: CodingPrinciplesPolicyView;
  enforcement: EnforcementPolicyView;
};

/**
 * Policy rule: derive warning/blocker messages from the node's contract state and the active
 * policies. `strictness === "block"` routes forbidden dependencies to blockers (which fail the
 * node); anything else routes them to warnings.
 *
 * NUKRYPIMAS NUO ETALONO (task 130, griežtinantis; migration-coverage.json 2026-09-02):
 * etalonas kiekvieną `forbidden_dependencies` įrašą pažymėdavo KIEKVIENAM mazgui, nė karto
 * nepatikrinęs, ar mazgas su ta priklausomybe apskritai susijęs. Su `strictness: "block"` ir
 * bent vienu įrašu NĖ VIENAS mazgas nebūtų pasiekęs `done` — block režimas buvo nenaudojamas
 * pagal konstrukciją. Dabar įrašas gradudojamas per `detectForbiddenDependencyViolations`
 * (ta pati funkcija, kurią naudoja preflight — kopija NEKURIAMA) prieš mazgo
 * `implemented_files`: sąsajos nėra → tam mazgui negeneruojama NIEKO. Kontekstas paduodamas
 * tuščias sąmoningai — per-node verifikacija neturi nei task teksto, nei code-graph briaunų,
 * tad vienintelis čia pasiekiamas įrodymas yra scope kelias, ir jis yra `confirmed`.
 *
 * PC-CODING-01 / decision (task 924-05): `policies.codingPrinciples` is accepted for
 * schema-completeness but intentionally NOT read here. Its six per-principle levels grade
 * qualitative design judgments about a file's structure — there is no static analyzer anywhere
 * in this codebase that computes "this file violates SRP/DRY/YAGNI" as an objective signal the
 * way `forbidden_dependencies` computes a concrete import-edge match. Per-node verification only
 * sees the node's own `implemented_files` list; inventing a heuristic here would either miss
 * real design issues or produce false positives with no way for the operator to distinguish a
 * real block from noise. `coding-principles.json` therefore stays informational.
 */
export function evaluatePolicies(
  nodeId: string,
  nodeProgress: ArchitectureNodeProgress,
  policies: NodeVerificationPolicies,
): { policy_warnings: string[]; policy_blockers: string[] } {
  const policy_warnings: string[] = [];
  const policy_blockers: string[] = [];
  const { architectureStyle, enforcement } = policies;

  if (enforcement.require_interface_contract_for_public_changes && !nodeProgress.interface_contract) {
    policy_warnings.push(
      `Node "${nodeId}" is missing an interface_contract but require_interface_contract_for_public_changes is enabled.`,
    );
  }

  for (const violation of detectForbiddenDependencyViolations(architectureStyle, nodeProgress.implemented_files)) {
    const message = `Forbidden dependency: "${violation.dependency}" — ${violation.sources.join("; ")}`;
    if (architectureStyle.strictness === "block") {
      policy_blockers.push(message);
    } else {
      policy_warnings.push(message);
    }
  }

  return { policy_warnings, policy_blockers };
}
