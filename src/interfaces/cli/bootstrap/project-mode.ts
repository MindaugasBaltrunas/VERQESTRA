// `project-mode` CLI adapteris (etalonas: interfaces/cli/project-mode/index.ts). Tik
// argumentai ir eilutės — signalų rinkimas gyvena application/project-bootstrap/detect-mode,
// o sprendimas — grynas domain/project classifyProjectMode.
//
// Komanda yra PATARIAMOJI: jos verdikto neskaito nė vienas produkcinis kelias (žr. detect-mode
// antraštę). `repair_project` čia nėra task lygio repair pipeline'as.

import {
  detectProjectMode,
  type ProjectModeDetectionPorts,
} from "../../../application/project-bootstrap/detect-mode.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ProjectModeCommandDeps = {
  ports: ProjectModeDetectionPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`) — repair promptų įrodymai. */
  runtimeRoot?: string;
  io?: CliIo;
};

export async function projectModeCommand(deps: ProjectModeCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const detection = await detectProjectMode(deps.ports, {
      projectRoot: deps.projectRoot,
      ...(deps.runtimeRoot === undefined ? {} : { runtimeRoot: deps.runtimeRoot }),
    });

    if (args.includes("--json")) {
      io.out(JSON.stringify(detection, null, 2));
      return 0;
    }

    io.out(`project-mode: ${detection.mode}`);
    io.out(`confidence: ${detection.confidence}`);
    for (const reason of detection.reasons) io.out(`reason: ${reason}`);
    io.out(`product_markers: ${detection.signals.productMarkers.length}`);
    io.out(`source_files: ${detection.signals.sourceFiles.length}`);
    io.out(`openspec_changes: ${detection.signals.openSpecChanges.length}`);
    io.out(`queued_tasks: ${detection.signals.queuedTasks}`);
    io.out(`interrupted_tasks: ${detection.signals.interruptedTasks}`);
    io.out(`human_review_tasks: ${detection.signals.humanReviewTasks}`);
    io.out(`repair_prompts: ${detection.signals.repairPrompts}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
