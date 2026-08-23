// Registro pjuviu bendras tipas. Atskiras failas, kad `cli-commands-*` moduliai netaptu
// ciklinia priklausomybe su `cli-registry.ts`: tipas keliauja i lapa, o surinkimas lieka sakoje.

import type { CliIo } from "../../interfaces/cli/registry.js";
import type { RuntimeRoots } from "../runtime/context.js";

export type CliRegistryDeps = {
  roots: RuntimeRoots;
  io?: CliIo;
};
