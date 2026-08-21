// `verqestra` komandų registras (etalonas: AG_loop orchestrator/runtime/command-registry.ts).
//
// Registras yra VIENINTELIS komandų sąrašo šaltinis: iš jo statoma ir dispatch'o lentelė, ir
// `help` išvestis. Du sąrašai ilgainiui prasilenktų, ir `help` imtų meluoti apie tai, kas realiai
// veikia.
//
// Pats surišimas su portais gyvena teminiuose `cli-commands-*` pjūviuose (dydžio vartas
// ≤500 eilučių); čia lieka SURINKIMAS ir tvarka. Tvarka yra kontraktas: `help` rodo komandas
// būtent šia seka, o PostToolUse hook'ai sąmoningai eina po operatoriaus komandų.

import { hookPostBash, hookPostBashSync, hookPostRead } from "../interfaces/hooks/post-hooks.js";
import { hookPostWrite } from "../interfaces/hooks/post-write.js";
import { renderCliCommandList, type CliCommand } from "../interfaces/cli/registry.js";
import { architectureCommands } from "./cli-commands-architecture.js";
import { auditCommands } from "./cli-commands-audit.js";
import { integrationsCommands } from "./cli-commands-integrations.js";
import { opsCommands } from "./cli-commands-ops.js";
import { specCommands } from "./cli-commands-spec.js";
import { tasksCommands } from "./cli-commands-tasks.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { postHookPorts } from "./hook-adapters.js";

export type { CliRegistryDeps } from "./cli-registry-types.js";

/**
 * Migruotos ir surištos komandos. Sąrašas auga kartu su VQ-504 dalimis — kol komanda čia
 * neįrašyta, ji CLI neegzistuoja ir `help` jos nerodo. Tai sąmoninga: rodyti komandą, kurios
 * dispatch'as nepasiekia, reikštų meluoti operatoriui.
 */
export function buildCliCommands(deps: CliRegistryDeps): CliCommand[] {
  return [
    ...specCommands(deps),
    ...tasksCommands(deps),
    ...auditCommands(deps),
    ...opsCommands(deps),
    ...architectureCommands(deps),
    ...integrationsCommands(deps),
    // --- PostToolUse hook'ai (VQ-502) --------------------------------------------------
    // Jie NIEKADA neblokuoja: handler'iai grąžina 0, o dispatch'as tą kodą tik perduoda.
    ...postToolUseCommands(deps),
  ];
}

/** `help` tekstas: antraštė plius registro eilutės deklaravimo tvarka. */
export function renderCliHelp(commands: readonly CliCommand[]): string[] {
  return ["Usage: verqestra <command> [args]", "", "Commands:", ...renderCliCommandList(commands).map((line) => `  ${line}`)];
}

/**
 * PostToolUse hook'ų įėjimai. Visi dalijasi tais pačiais portais, tad jie sudedami vienu
 * pjūviu — kiekvienas atskirai kartotų tą patį surišimą.
 */
function postToolUseCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  const hookDeps = {
    ports: postHookPorts(),
    projectRoot: deps.roots.projectRoot,
    runtimeRoot: deps.roots.runtimeRoot,
    ...(io === undefined ? {} : { io }),
  };

  return [
    {
      name: "hook-post-bash",
      description: "PostToolUse: Bash žurnalas ir digest shadow telemetrija",
      run: () => hookPostBash(hookDeps),
    },
    {
      name: "hook-post-bash-sync",
      description: "PostToolUse: sinchroninis Bash išvesties digest kelias",
      run: () => hookPostBashSync(hookDeps),
    },
    {
      name: "hook-post-read",
      description: "PostToolUse: readme skaitymo įrodymas",
      run: () => hookPostRead(hookDeps),
    },
    {
      name: "hook-post-write",
      description: "PostToolUse: sesijos rašymų ledger'is ir KPI įvykiai",
      run: () => hookPostWrite(hookDeps),
    },
  ];
}
