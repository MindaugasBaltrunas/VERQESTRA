// `openspec-reconcile` CLI adapteris (etalonas: interfaces/cli/openspec-reconcile/index.ts
// printOpenSpecReconcile pusė; suderinimo logika — application/task-execution/
// openspec-reconcile, task 0030).
//
// Exit kodai: `0` — suderinta; `1` — liko neuždarytų auto change'ų arba operatoriaus
// sprendimo laukiančių baigčių; `2` — netikėta klaida. `1` čia reiškia „ataskaita
// paskaičiuota, likutis yra", ne įrankio gedimą — tas pats kontraktas kaip `ag converge`.
//
// Numatytasis režimas — dry-run (tik ataskaita, jokio rašymo); archyvuoja TIK su
// `--apply`. `--dry-run` priimamas kaip aiškus numatytosios elgsenos sinonimas
// (atgalinis suderinamumas skriptams). `--apply` kartu su `--dry-run` — usage klaida,
// exit 2.

import {
  reconcileAutoOpenSpecBacklog,
  type OpenSpecReconcileFsPort,
} from "../../../application/task-execution/openspec-reconcile.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type OpenSpecReconcileCommandDeps = {
  fs: OpenSpecReconcileFsPort;
  /** `<root>/AG` — openspec/changes ir tasks/done šaknis. */
  agRoot: string;
  io?: CliIo;
};

export async function openSpecReconcileCommand(deps: OpenSpecReconcileCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const apply = args.includes("--apply");
    if (apply && args.includes("--dry-run")) {
      io.error("openspec-reconcile: --apply and --dry-run are mutually exclusive");
      return 2;
    }
    const dryRun = !apply;
    const report = await reconcileAutoOpenSpecBacklog(deps.fs, deps.agRoot, { dryRun });

    if (args.includes("--json")) {
      io.out(JSON.stringify(report, null, 2));
    } else {
      const verb = dryRun ? "would archive" : "archived";
      io.out(`openspec-reconcile: ${report.status} (${report.scanned_done_tasks} done tasks scanned)`);
      if (dryRun) io.out("dry run — re-run with --apply to archive");
      io.out(`${verb}: ${report.archived.length} of ${report.active_auto_changes_before} active auto changes`);
      for (const entry of report.archived) io.out(`  ${verb}: ${entry.change} <- ${entry.task}`);
      for (const change of report.unmatched_auto_changes) io.out(`  no done task: ${change}`);
      for (const error of report.errors) {
        io.out(`  needs operator: ${error.task} — ${error.reason}${error.change ? ` (${error.change})` : ""}`);
      }
      for (const named of report.named_changes_open) {
        io.out(`  human-owned, ${named.open_items} open item(s): ${named.change}`);
      }
    }
    return report.status === "reconciled" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
