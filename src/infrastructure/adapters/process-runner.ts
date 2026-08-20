// Vykdymo adapterių proceso runner'io kontraktas (etalonas: AG_loop
// infrastructure/adapters/process-runner.ts) — testai paduoda fake, produkcija runWithInput.

import type { CommandResult } from "../process/run-process.js";

export type ExecutionProcessRunner = (
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs?: number,
) => Promise<CommandResult>;

export type CodexProcessRunner = ExecutionProcessRunner;
