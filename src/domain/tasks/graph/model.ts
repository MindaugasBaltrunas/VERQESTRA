// Canonical persistent task DAG — the value model (PDAG-1/PDAG-2). Before this model the
// only dependency representation was the Markdown bucket tree, which cannot answer "is
// this graph acyclic, does every blocker exist, is any id claimed twice" and cannot be
// restored after a restart. Pure: same inputs → same graph, hash and violations.
// Behaviour etalon: AG_loop domain/tasks/task-graph.ts (WBR VQ-201 split: 549 → 5 modulių).

import type { TaskBucket } from "../buckets.js";

/** Snapshot format version. A snapshot written by a different version is not interpreted. */
export const TASK_GRAPH_SCHEMA_VERSION = 1;

/**
 * Version of the normalization/validation RULES — part of the hashed payload, so changing
 * how a graph is built or validated invalidates every previously written hash.
 */
export const TASK_GRAPH_RULES_VERSION = 1;

/** Execution status of a node — deliberately independent of the on-disk bucket. */
export const TASK_NODE_STATUSES = ["queued", "running", "blocked", "done", "failed", "human-review"] as const;
export type TaskNodeStatus = (typeof TASK_NODE_STATUSES)[number];

/** Where an edge came from: a task file's `## Dependencies`, or a runtime decision. */
export const TASK_DEPENDENCY_ORIGINS = ["markdown", "runtime"] as const;
export type TaskDependencyOrigin = (typeof TASK_DEPENDENCY_ORIGINS)[number];

export type TaskNode = {
  task_id: string;
  /** Repo-relative task file path (POSIX separators) — the dispatch address. */
  file: string;
  status: TaskNodeStatus;
  /** Verification commands from `## Patikra`. A node without them cannot be proven done. */
  checks: string[];
  /** Allowed paths from `## Failai` — the task's hard edit boundary. */
  scope: string[];
  /**
   * Symbols the task will write. Absence means "not declared", NOT "writes nothing":
   * an undeclared symbol set is missing evidence, never proof of independence.
   */
  write_symbols?: string[];
  /** Architecture-graph nodes the task owns while it runs; same "absent ≠ empty" rule. */
  architecture_nodes?: string[];
  /** Task is gated behind a human decision (risk gates, supervisor approval). */
  requires_approval: boolean;
  /** That decision has been granted (e.g. a `HUMAN-REVIEW-APPROVED` marker). */
  approved: boolean;
  /** Optional budget cost estimate, in tokens; used by the ready-set budget gate. */
  estimated_tokens?: number;
};

/** A single directed edge: `task_id` cannot start before `depends_on` is done. */
export type TaskDependency = {
  task_id: string;
  depends_on: string;
  origin: TaskDependencyOrigin;
};

export type TaskGraph = {
  schema_version: number;
  rules_version: number;
  /** Content fingerprint over the canonical node/edge form. Same graph → same hash. */
  graph_hash: string;
  nodes: TaskNode[];
  dependencies: TaskDependency[];
};

export type TaskGraphNodeInput = {
  task_id: string;
  file: string;
  status?: TaskNodeStatus;
  checks?: readonly string[];
  scope?: readonly string[];
  write_symbols?: readonly string[];
  architecture_nodes?: readonly string[];
  requires_approval?: boolean;
  approved?: boolean;
  estimated_tokens?: number;
  /** Convenience form of the edges declared by this node (Markdown `blocked_by`). */
  depends_on?: readonly string[];
};

export type TaskDependencyInput = {
  task_id: string;
  depends_on: string;
  origin?: TaskDependencyOrigin;
};

export type TaskGraphInput = {
  nodes: readonly TaskGraphNodeInput[];
  dependencies?: readonly TaskDependencyInput[];
};

/**
 * Bucket → status. `active`/`delegated` are both "a worker holds this task"; `error`/
 * `failed` are both "the last attempt did not succeed". One-way on purpose: status is the
 * canonical value, the bucket is only one of the ways to observe it.
 */
export function taskNodeStatusFromBucket(bucket: TaskBucket): TaskNodeStatus {
  switch (bucket) {
    case "queue":
      return "queued";
    case "active":
    case "delegated":
      return "running";
    case "error":
    case "failed":
      return "failed";
    case "human-review":
      return "human-review";
    case "done":
      return "done";
  }
}

/** True when the task has come to rest: no further automated transition applies. */
export function isTerminalTaskNodeStatus(status: TaskNodeStatus): boolean {
  return status === "done" || status === "human-review" || status === "failed";
}

/** True when a blocker in this status counts as satisfied. Only accepted work does. */
export function satisfiesDependency(status: TaskNodeStatus): boolean {
  return status === "done";
}

export function compareNodes(a: TaskNode, b: TaskNode): number {
  return a.task_id.localeCompare(b.task_id) || a.file.localeCompare(b.file);
}

export function compareDependencies(a: TaskDependency, b: TaskDependency): number {
  return a.task_id.localeCompare(b.task_id) || a.depends_on.localeCompare(b.depends_on) || a.origin.localeCompare(b.origin);
}
