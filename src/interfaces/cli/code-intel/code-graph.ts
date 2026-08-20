// `code-graph` CLI adapteris (etalonas: interfaces/cli/code-graph/index.ts). Užklausos
// logika — application/code-intelligence query; čia lieka argumentų parsinimas ir etalono
// console eilutės 1:1 (top-20 sąrašo kirpimas — rendinimo, ne užklausos taisyklė).

import { queryCodeGraph } from "../../../application/code-intelligence/query/query.js";
import type { CodeIntelligenceFileSystemPort } from "../../../application/code-intelligence/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type CodeGraphCommandDeps = {
  codeFs: CodeIntelligenceFileSystemPort;
  projectRoot: string;
  io?: CliIo;
};

export async function codeGraphCommand(deps: CodeGraphCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const subcommand = args[0] ?? "query";
    const target = subcommand === "query" ? args[1] : args[0];
    const asJson = args.includes("--json");
    const fuzzy = args.includes("--fuzzy");
    if (!target) {
      io.error("Usage: ag code-graph query <file-or-symbol> [--json] [--fuzzy]");
      return 2;
    }

    const result = await queryCodeGraph(deps.codeFs, deps.projectRoot, target, { fuzzy });
    if (asJson) {
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }

    io.out(`code-graph: ${result.target}`);
    if (fuzzy) io.out("matching: fuzzy");
    printList(io, "matched_files", result.matched_files.map((file) => file.path));
    printList(io, "matched_symbols", result.matched_symbols.map((symbol) => symbol.id));
    printList(io, "imports", result.imports);
    printList(io, "importers", result.importers);
    printList(io, "impacted_tests", result.impacted_tests);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function printList(io: CliIo, label: string, values: string[]): void {
  io.out(`${label}: ${values.length}`);
  for (const value of values.slice(0, 20)) {
    io.out(`- ${value}`);
  }
}
