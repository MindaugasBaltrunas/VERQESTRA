// `verqestra` komandų registras (etalonas: AG_loop orchestrator/runtime/command-registry.ts).
//
// Registras yra VIENINTELIS komandų sąrašo šaltinis: iš jo statoma ir dispatch'o lentelė, ir
// `help` išvestis. Du sąrašai ilgainiui prasilenktų, ir `help` imtų meluoti apie tai, kas realiai
// veikia.
//
// Pats surišimas su portais gyvena teminiuose `cli-commands-*` pjūviuose (dydžio vartas
// ≤500 eilučių); čia lieka SURINKIMAS ir tvarka. Tvarka yra kontraktas: `help` rodo komandas
// būtent šia seka, o hook'ai sąmoningai eina po operatoriaus komandų.

import { renderCliCommandList, type CliCommand } from "../interfaces/cli/registry.js";
import { architectureCommands } from "./cli-commands-architecture.js";
import { auditCommands } from "./cli-commands-audit.js";
import { hookCommands } from "./cli-commands-hooks.js";
import { integrationsCommands } from "./cli-commands-integrations.js";
import { opsCommands } from "./cli-commands-ops.js";
import { specCommands } from "./cli-commands-spec.js";
import { tasksCommands } from "./cli-commands-tasks.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";

export type { CliRegistryDeps } from "./cli-registry-types.js";

/**
 * Migruotos ir surištos komandos. Kol komanda čia neįrašyta, ji CLI neegzistuoja ir `help` jos
 * nerodo. Tai sąmoninga: rodyti komandą, kurios dispatch'as nepasiekia, reikštų meluoti
 * operatoriui.
 *
 * ATVIRKŠTINĖ pusė yra lygiai tokia pat svarbi ir 2026-08-22 pasirodė realiai: hook modulis,
 * parašytas ir ištestuotas, bet čia neįrašytas, yra NEPASIEKIAMAS — ir joks CLI auditas to
 * nepamato, nes auditas leidžia komandas IŠ ŠIO sąrašo. Registro pilnumas tikrinamas prieš
 * ETALONO registrą, ne prieš patį save.
 */
export function buildCliCommands(deps: CliRegistryDeps): CliCommand[] {
  return [
    ...specCommands(deps),
    ...tasksCommands(deps),
    ...auditCommands(deps),
    ...opsCommands(deps),
    ...architectureCommands(deps),
    ...integrationsCommands(deps),
    ...hookCommands(deps),
  ];
}

/** `help` tekstas: antraštė plius registro eilutės deklaravimo tvarka. */
export function renderCliHelp(commands: readonly CliCommand[]): string[] {
  return ["Usage: verqestra <command> [args]", "", "Commands:", ...renderCliCommandList(commands).map((line) => `  ${line}`)];
}
