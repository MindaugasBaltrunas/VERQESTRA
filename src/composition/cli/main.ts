// CLI dispatch'as: argumentai → komanda → exit kodas (etalonas: AG_loop cli.ts + command-registry
// `dispatch`).
//
// Exit kodo VIENA priskyrimo vieta yra `cli.ts`; čia jis GRĄŽINAMAS. Taip visą matomą elgesį
// (spausdintas eilutes ir galutinį kodą) galima patikrinti be proceso.
//
// Neperimta klaida NIEKADA neišeina pro šį kraštą: nežinoma išimtis virsta 1, o infrastruktūros
// errno (`EACCES`, `EBUSY`, ...) — savo kodu, kad orkestratorius atskirtų aplinkos gedimą nuo
// užduoties nesėkmės.

import { consoleCliIo, findCliCommand, validateCliRegistry, type CliCommand, type CliIo } from "../../interfaces/cli/registry.js";
import { USAGE_ERROR_EXIT_CODE, infrastructureExitCodeForError } from "../../shared/exit-codes.js";
import { WorkflowInfrastructureError } from "../../shared/errors.js";
import { buildCliCommands, renderCliHelp, type CliRegistryDeps } from "./registry.js";
import { resolveRuntimeRoots } from "../runtime/context.js";

/** Nežinoma programos klaida: ne usage, ne aplinka. */
const UNEXPECTED_ERROR_EXIT_CODE = 1;

export const CLI_VERSION = "verqestra 0.1.0";

export type CliMainDeps = {
  commands: readonly CliCommand[];
  io?: CliIo;
};

export async function runCli(deps: CliMainDeps, argv: readonly string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;

  // Registro invariantas tikrinamas PRIEŠ dispatch'ą: dublikuotas vardas reiškia, kad viena iš
  // dviejų komandų niekada nebus pasiekiama, o tylus nugalėtojas priklausytų nuo deklaravimo
  // tvarkos.
  const violations = validateCliRegistry(deps.commands);
  if (violations.length > 0) {
    for (const violation of violations) io.error(`cli registry: ${violation}`);
    return UNEXPECTED_ERROR_EXIT_CODE;
  }

  const name = argv[0];
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    for (const line of renderCliHelp(deps.commands)) io.out(line);
    // Be argumentų `help` yra teisingas atsakymas, ne klaida.
    return 0;
  }
  if (name === "version" || name === "--version" || name === "-v") {
    io.out(CLI_VERSION);
    return 0;
  }

  const command = findCliCommand(deps.commands, name);
  if (!command) {
    io.error(`Unknown command: ${name}`);
    io.error("Run 'verqestra help' to see available commands.");
    return USAGE_ERROR_EXIT_CODE;
  }

  try {
    return await command.run([...argv.slice(1)]);
  } catch (error: unknown) {
    io.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof WorkflowInfrastructureError && error.exitCode !== undefined) return error.exitCode;
    return infrastructureExitCodeForError(error) ?? UNEXPECTED_ERROR_EXIT_CODE;
  }
}

/** Production įėjimas: šaknys iš aplinkos, komandos iš registro. */
export async function runCliFromEnv(argv: readonly string[], overrides: Partial<CliRegistryDeps> = {}): Promise<number> {
  const roots = overrides.roots ?? resolveRuntimeRoots({ env: (name) => process.env[name] });
  const commands = buildCliCommands({ roots, ...(overrides.io === undefined ? {} : { io: overrides.io }) });
  return await runCli({ commands, ...(overrides.io === undefined ? {} : { io: overrides.io }) }, argv);
}
