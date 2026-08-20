// `release-notes` CLI adapteris (etalonas: interfaces/cli/release-notes/index.ts).
// Generavimas — application/release-readiness/release-notes per ReleaseNotesPorts;
// etalono elgesys 1:1: ir generated, ir disabled baigtys grąžina 0 (verdiktas — eilutėse).

import {
  generateReleaseNotes,
  type ReleaseNotesPorts,
} from "../../../application/release-readiness/release-notes.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ReleaseNotesCommandDeps = {
  ports: ReleaseNotesPorts;
  now?: () => Date;
  io?: CliIo;
};

export async function releaseNotesCommand(deps: ReleaseNotesCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await generateReleaseNotes(deps.ports, deps.now === undefined ? undefined : deps.now());
    if (args.includes("--json")) {
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    io.out(`release-notes: ${result.status}`);
    io.out(`path: ${result.path}`);
    io.out(`done_tasks: ${result.done_tasks}`);
    io.out(`release_check_status: ${result.release_check_status}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
