// Dry-run adapteris (etalonas 1:1): jokio išorinio darbo, visada completed.

import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../domain/agents/execution-port.js";

export class DryRunAdapter implements ExecutionAdapter {
  readonly kind = "dry-run" as const;

  execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return Promise.resolve({
      adapter: this.kind,
      status: "completed",
      exitCode: 0,
      stdout: "dry-run execution skipped for " + request.taskId,
      stderr: "",
      reason: "dry_run_no_external_work",
    });
  }
}
