// Deterministic pre-execution task-graph validation. `executable === false` is not
// negotiable: a graph with a cycle, a duplicate id, a foreign schema version or a hash
// that does not match its content describes no plan at all — executing it means guessing.
// Node-scoped findings disqualify only the tasks they name; missing checks/scope are
// warnings, because preflight — not the graph — is the gate that blocks such a task.
// Behaviour etalon: AG_loop validateTaskGraph/assertExecutableTaskGraph.

import { computeTaskGraphHash } from "./hash.js";
import {
  TASK_GRAPH_SCHEMA_VERSION,
  isTerminalTaskNodeStatus,
  satisfiesDependency,
  type TaskGraph,
} from "./model.js";
import { detectTaskGraphCycles, resolveTaskNode } from "./traverse.js";

export type TaskGraphViolationCode =
  | "duplicate-task-id"
  | "missing-dependency"
  | "dependency-cycle"
  | "invalid-terminal-dependency"
  | "missing-checks"
  | "missing-scope"
  | "graph-hash-mismatch"
  | "schema-version-mismatch";

export type TaskGraphViolationSeverity = "error" | "warning";

/**
 * `graph` violations invalidate the whole graph (nothing may execute); `node` violations
 * disqualify only the tasks they name — one unresolvable dependency parks a single task
 * without stopping every unrelated branch, while a cycle or duplicate id stops everything.
 */
export type TaskGraphViolationScope = "graph" | "node";

export type TaskGraphViolation = {
  code: TaskGraphViolationCode;
  severity: TaskGraphViolationSeverity;
  scope: TaskGraphViolationScope;
  task_id?: string;
  dependency?: string;
  /** Participants of a cycle, sorted. */
  members?: string[];
  message: string;
};

export type TaskGraphValidation = {
  /** No error-severity violation of any scope. */
  ok: boolean;
  /** No error-severity `graph`-scope violation: the graph may be used to schedule work. */
  executable: boolean;
  violations: TaskGraphViolation[];
  /** Detected cycles; each is a sorted set of participants. */
  cycles: string[][];
};

function violation(
  code: TaskGraphViolationCode,
  severity: TaskGraphViolationSeverity,
  scope: TaskGraphViolationScope,
  message: string,
  detail: Pick<TaskGraphViolation, "task_id" | "dependency" | "members"> = {},
): TaskGraphViolation {
  return { code, severity, scope, message, ...detail };
}

export function validateTaskGraph(graph: TaskGraph): TaskGraphValidation {
  const violations: TaskGraphViolation[] = [];

  if (graph.schema_version !== TASK_GRAPH_SCHEMA_VERSION) {
    violations.push(
      violation(
        "schema-version-mismatch",
        "error",
        "graph",
        `task graph schema version ${graph.schema_version} is not the supported ${TASK_GRAPH_SCHEMA_VERSION}`,
      ),
    );
  }

  const expectedHash = computeTaskGraphHash(graph);
  if (graph.graph_hash !== expectedHash) {
    violations.push(
      violation(
        "graph-hash-mismatch",
        "error",
        "graph",
        `task graph hash ${graph.graph_hash || "<empty>"} does not match its content (${expectedHash})`,
      ),
    );
  }

  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.task_id)) {
      violations.push(
        violation("duplicate-task-id", "error", "graph", `task id ${node.task_id} is declared by more than one node`, {
          task_id: node.task_id,
        }),
      );
      continue;
    }
    seen.add(node.task_id);
  }

  const { groups: cycles } = detectTaskGraphCycles(graph);
  for (const group of cycles) {
    violations.push(
      violation("dependency-cycle", "error", "graph", `dependency cycle: ${group.join(" -> ")}`, { members: group }),
    );
  }

  for (const edge of graph.dependencies) {
    if (!seen.has(edge.task_id)) continue;
    const blocker = resolveTaskNode(graph, edge.depends_on);
    if (!blocker) {
      violations.push(
        violation("missing-dependency", "error", "node", `task ${edge.task_id} depends on unknown task ${edge.depends_on}`, {
          task_id: edge.task_id,
          dependency: edge.depends_on,
        }),
      );
      continue;
    }
    if (isTerminalTaskNodeStatus(blocker.status) && !satisfiesDependency(blocker.status)) {
      violations.push(
        violation(
          "invalid-terminal-dependency",
          "error",
          "node",
          `task ${edge.task_id} depends on ${blocker.task_id}, which rests in terminal status "${blocker.status}" and can never satisfy it`,
          { task_id: edge.task_id, dependency: blocker.task_id },
        ),
      );
    }
  }

  for (const node of graph.nodes) {
    if (node.checks.length === 0) {
      violations.push(
        violation("missing-checks", "warning", "node", `task ${node.task_id} declares no verification checks`, {
          task_id: node.task_id,
        }),
      );
    }
    if (node.scope.length === 0) {
      violations.push(
        violation("missing-scope", "warning", "node", `task ${node.task_id} declares no allowed-paths scope`, {
          task_id: node.task_id,
        }),
      );
    }
  }

  const errors = violations.filter((entry) => entry.severity === "error");
  return {
    ok: errors.length === 0,
    executable: !errors.some((entry) => entry.scope === "graph"),
    violations,
    cycles,
  };
}

// `assertExecutableTaskGraph` gyveno cia iki 2026-08-22: metanti apvalkalė aplink
// `validateTaskGraph`, kurios doc'as teigė esąs „the single guard every execution path goes
// through". Nė vieno kvietėjo ji neturėjo. Vartas, aprašytas kaip vienintelis, ir nepasiekiamas
// iš niekur, yra blogiau nei jo nebuvimas: jis atrodo kaip apsauga tam, kas jos ieško.
// Tikra apsauga yra `buildReadySet`, tikrinantis `validation.executable` pats.
