// StackSignals ekstrakcija iš architektūros grafo + evidence ledger'io. Behaviour etalon:
// AG_loop architecture/stack-signals.ts (ekstrakcijos pusė). Tipas StackSignals ir
// stackSignalsToInputSignals gyvena domain/policies/stack-decision (VQ-203) — čia
// NEdubliuojami (FQC-12); šis modulis tik gamina reikšmę, kurią vartoja domain matrica.

import type { ArchitectureGraph, ArchitectureNode } from "../../../domain/architecture/graph.js";
import type { EvidenceEntry } from "../../../domain/architecture/evidence.js";
import type { StackSignalAppType, StackSignals } from "../../../domain/policies/stack-decision.js";

const UI_KEYWORDS = ["ui", "web", "frontend", "mobile", "app screen", "page", "component", "view"];
const API_KEYWORDS = [
  "api",
  "endpoint",
  "rest",
  "graphql",
  "controller",
  "route",
  "gateway",
  "backend",
  "service",
];
const DATA_KEYWORDS = [
  "db",
  "database",
  "postgres",
  "postgis",
  "mysql",
  "sqlite",
  "store",
  "schema",
  "table",
  "repository",
  "cache",
  "redis",
];
const INTEGRATION_KEYWORDS = [
  "external",
  "third-party",
  "webhook",
  "sdk",
  "integration",
  "provider",
  "vendor",
];

const DEPLOYMENT_HINT_KEYWORDS: Record<string, string> = {
  docker: "deployment:docker",
  kubernetes: "deployment:kubernetes",
  k8s: "deployment:kubernetes",
  serverless: "deployment:serverless",
  lambda: "deployment:serverless",
  vercel: "deployment:vercel",
  "cloud run": "deployment:cloud-run",
  vm: "deployment:vm",
  "on-prem": "deployment:on-prem",
  container: "deployment:container",
};

const RISK_HINT_KEYWORDS: Record<string, string> = {
  pii: "risk:pii",
  "personal data": "risk:pii",
  gdpr: "risk:pii",
  payment: "risk:payment",
  billing: "risk:payment",
  stripe: "risk:payment",
  pci: "risk:payment",
  auth: "risk:auth",
  authentication: "risk:auth",
  authorization: "risk:auth",
  rbac: "risk:auth",
  permission: "risk:auth",
  secret: "risk:secrets",
  credential: "risk:secrets",
  token: "risk:secrets",
  "api key": "risk:secrets",
  legacy: "risk:legacy",
  deprecated: "risk:legacy",
};

function nodeText(node: ArchitectureNode): string {
  return `${node.label} ${node.description ?? ""}`.toLowerCase();
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function dedupeSort(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

function categorizeNodes(nodes: ArchitectureNode[]): {
  uiNodeIds: string[];
  apiNodeIds: string[];
  dataNodeIds: string[];
  integrationNodeIds: string[];
} {
  const uiNodeIds: string[] = [];
  const apiNodeIds: string[] = [];
  const dataNodeIds: string[] = [];
  const integrationNodeIds: string[] = [];

  for (const node of nodes) {
    const text = nodeText(node);
    let isData = false;
    let isApi = false;

    if (node.kind === "store" || includesAny(text, DATA_KEYWORDS)) {
      dataNodeIds.push(node.id);
      isData = true;
    }

    if (node.external === true || includesAny(text, INTEGRATION_KEYWORDS)) {
      integrationNodeIds.push(node.id);
    }

    if (!isData) {
      if (node.kind === "adapter" || includesAny(text, API_KEYWORDS)) {
        apiNodeIds.push(node.id);
        isApi = true;
      }
    }

    if (!isData && !isApi) {
      if (node.kind === "component" || includesAny(text, UI_KEYWORDS)) {
        uiNodeIds.push(node.id);
      }
    }
  }

  return {
    uiNodeIds: dedupeSort(uiNodeIds),
    apiNodeIds: dedupeSort(apiNodeIds),
    dataNodeIds: dedupeSort(dataNodeIds),
    integrationNodeIds: dedupeSort(integrationNodeIds),
  };
}

function determineAppType(graph: ArchitectureGraph, uiNodeIds: string[], apiNodeIds: string[]): StackSignalAppType {
  if (graph.nodes.length === 0) return "unknown";
  if (uiNodeIds.length > 0 && apiNodeIds.length > 0) return "fullstack";
  if (uiNodeIds.length > 0) return "ui-only";
  if (apiNodeIds.length > 0) return "api-only";

  const hasWorkerSignal = graph.nodes.some((node) => {
    const text = nodeText(node);
    return node.kind === "gate" || text.includes("worker") || text.includes("job") || text.includes("queue");
  });
  if (hasWorkerSignal) return "worker-only";

  return "unknown";
}

function complexityLevel(nodeCount: number, edgeCount: number): "low" | "medium" | "high" {
  if (nodeCount <= 5 && edgeCount <= 6) return "low";
  if (nodeCount <= 15 && edgeCount <= 25) return "medium";
  return "high";
}

function collectKeywordHints(
  keywordTable: Record<string, string>,
  nodes: ArchitectureNode[],
  evidence: EvidenceEntry[],
): string[] {
  const texts: string[] = nodes.map((node) => nodeText(node));
  for (const entry of evidence) {
    texts.push(entry.excerpt.toLowerCase());
  }

  const hints: string[] = [];
  for (const [keyword, tag] of Object.entries(keywordTable)) {
    if (texts.some((text) => text.includes(keyword))) {
      hints.push(tag);
    }
  }

  return dedupeSort(hints);
}

export function extractStackSignals(graph: ArchitectureGraph, evidence: EvidenceEntry[] = []): StackSignals {
  const { uiNodeIds, apiNodeIds, dataNodeIds, integrationNodeIds } = categorizeNodes(graph.nodes);
  const appType = determineAppType(graph, uiNodeIds, apiNodeIds);

  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  const externalNodeCount = graph.nodes.filter((node) => node.external === true).length;

  const deploymentHints = collectKeywordHints(DEPLOYMENT_HINT_KEYWORDS, graph.nodes, evidence);
  const riskHints = collectKeywordHints(RISK_HINT_KEYWORDS, graph.nodes, evidence);

  if (graph.nodes.some((node) => node.kind === "unknown")) {
    riskHints.push("risk:unmodeled-node");
  }

  return {
    appType,
    uiNodeIds,
    apiNodeIds,
    dataNodeIds,
    integrationNodeIds,
    complexity: {
      nodeCount,
      edgeCount,
      externalNodeCount,
      level: complexityLevel(nodeCount, edgeCount),
    },
    deploymentHints,
    riskHints: dedupeSort(riskHints),
  };
}
