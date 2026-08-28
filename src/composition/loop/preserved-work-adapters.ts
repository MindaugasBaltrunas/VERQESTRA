// Preserved-work review portų surišimas su realiais adapteriais (063-c-02).
//
// `PreservedWorkReviewPorts` (application) mato tik `materialize`/`runCheck` — jokio git ar
// child_process importo ten nėra. Šis failas yra vienintelė vieta loop composition'e, kuri žino,
// kad materializavimas yra `git worktree add` (infrastructure/git/preserved-work.ts), o `##
// Patikra` komandos paleidžiamos per shell (infrastructure/process/run-process.ts) su
// `cwd` = materializuotas worktree kelias.
import { materializePreservedWork } from "../../infrastructure/git/preserved-work.js";
import { runShell } from "../../infrastructure/process/run-process.js";
import type { PreservedWorkReviewPorts } from "../../application/task-execution/preserved-work-review-model.js";

export function preservedWorkReviewPort(input: { projectRoot: string }): PreservedWorkReviewPorts {
  return {
    materialize: async (ref) => {
      const result = await materializePreservedWork({ projectRoot: input.projectRoot, ref });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, work: result.work };
    },
    runCheck: async (worktreePath, command) => {
      const result = await runShell(command, worktreePath);
      return { exitCode: result.code, output: `${result.stdout}${result.stderr}` };
    },
  };
}
