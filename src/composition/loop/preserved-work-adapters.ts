// Preserved-work review portų surišimas (task 063-c): application `PreservedWorkReviewPorts`
// (063-a) gauna REALŲ materializavimą (`infrastructure/git/preserved-work.ts`) ir realų
// `## Patikra` komandų paleidimą (`infrastructure/process/run-process.ts`). Jokio sprendimo čia
// nėra — recovered/needs-human verdiktą priima `application/task-execution/preserved-work-review.ts`,
// šis failas tik jungia du infrastruktūros gabalus prie porto sąsajos.

import { materializePreservedWork, type MaterializePreservedWorkResult, type PreservedWorkRuntime } from "../../infrastructure/git/preserved-work.js";
import { runShell } from "../../infrastructure/process/run-process.js";
import type { PreservedWorkReviewPorts } from "../../application/task-execution/preserved-work-review-model.js";

export type PreservedWorkAdapterDeps = {
  projectRoot: string;
  /**
   * Kopijos bootstrap'as (dist/node_modules/konfigas) — be jo `## Patikra` komandos kaip
   * `pnpm typecheck` kristų dėl trūkstamo `dist`. Neprivalomas: testai ir minimalūs scenarijai
   * (patikros be projekto runtime) jo neduoda, ir tai yra tinkamas numatytas elgesys.
   */
  runtime?: PreservedWorkRuntime;
  log?: (message: string) => Promise<void>;
  /** `## Patikra` komandos timeout'as; be jo — be limito, kaip kitos ilgai trunkančios patikros. */
  checkTimeoutMs?: number;
};

/** Ta pati kopijos struktūra kaip loop'o slot'o worktree'ai (`command.ts` `prepareWorktree`). */
export function preservedWorkRuntimeLayout(projectRootRelativeConfigDir: string): PreservedWorkRuntime["layout"] {
  return {
    distDir: "dist",
    nodeModulesDir: "node_modules",
    configFiles: [`${projectRootRelativeConfigDir}/local.env`],
    configDirs: [projectRootRelativeConfigDir],
    optionalJunctions: [],
  };
}

function describeMaterializeFailure(result: Extract<MaterializePreservedWorkResult, { ok: false }>): string {
  switch (result.reason) {
    case "ref-not-found":
      return `ref-not-found ref=${result.ref}`;
    case "empty-diff":
      return `empty-diff ref=${result.ref} base=${result.baseRef}`;
    case "worktree-failed":
      return `worktree-failed ref=${result.ref} message=${result.message}`;
  }
}

/**
 * `PreservedWorkReviewPorts` realiam veikimui: `materialize` sukuria izoliuotą detached
 * worktree'ą (papildomai apruošdamas dist/node_modules, jei `deps.runtime` paduotas), `runCheck`
 * paleidžia vieną `## Patikra` eilutę per platformos shell'ą ant to worktree.
 */
export function preservedWorkReviewPorts(deps: PreservedWorkAdapterDeps): PreservedWorkReviewPorts {
  return {
    materialize: async (ref) => {
      const result = await materializePreservedWork({
        projectRoot: deps.projectRoot,
        ref,
        ...(deps.runtime === undefined ? {} : { runtime: deps.runtime }),
      });
      if (!result.ok) return { ok: false, reason: describeMaterializeFailure(result) };
      return { ok: true, work: result.work };
    },
    runCheck: async (worktreePath, command) => {
      const result = await runShell(command, worktreePath, deps.checkTimeoutMs);
      const output = result.stderr.trim() === "" ? result.stdout : `${result.stdout}\n${result.stderr}`;
      return { exitCode: result.code, output };
    },
  };
}
