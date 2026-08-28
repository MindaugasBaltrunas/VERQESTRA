// Ports and outcome contract for reviewing already-materialized preserved work (task 063-a).
// Verdict-only use-case: it decides whether a preserved-and-rolled-back attempt can be
// recovered, it never touches git or a shell itself. Materialization and command execution
// stay behind ports so the deciding logic has no `node:child_process` / git import at all.

export type MaterializedPreservedWork = {
  /** Detached worktree kelias, ant kurio paleidžiamos `## Patikra` komandos. */
  worktreePath: string;
  /** Keliai, kurie pasikeitė preserved commit'e — tikrinami prieš task'o `## Failai` allowlist. */
  changedPaths: string[];
  /** Pašalina worktree'ą; kviečiama po peržiūros, nepriklausomai nuo verdikto. */
  dispose(): Promise<void>;
};

export type MaterializePreservedWorkOutcome =
  | { ok: true; work: MaterializedPreservedWork }
  | { ok: false; reason: string };

export type PreservedWorkCheckResult = {
  command: string;
  exitCode: number;
  output: string;
};

export type PreservedWorkReviewPorts = {
  /** `refs/verqestra/preserved/<sha>` → izoliuotas worktree su pakeistų kelių sąrašu. */
  materialize(ref: string): Promise<MaterializePreservedWorkOutcome>;
  /** Vienos `## Patikra` komandos paleidimas ant materializuoto worktree. */
  runCheck(worktreePath: string, command: string): Promise<{ exitCode: number; output: string }>;
};

export type PreservedWorkReviewParams = {
  /** `refs/verqestra/preserved/<sha>`. */
  ref: string;
  /** Task'o Markdown — iš jo skaitomos `## Patikra` komandos ir `## Failai` allowlist. */
  taskMarkdown: string;
};

export type PreservedWorkReviewVerdict =
  | {
      verdict: "recovered";
      ref: string;
      changedPaths: string[];
      checks: PreservedWorkCheckResult[];
    }
  | {
      verdict: "needs-human";
      ref: string;
      reason: string;
      checks: PreservedWorkCheckResult[];
    };
