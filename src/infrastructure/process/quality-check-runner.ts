// Vieno quality-policy patikrinimo vykdymas (etalonas: application/quality-gates
// `runQualityCheck`, kurio IO pusė VERQESTRA architektūroje priklauso infrastruktūrai).
//
// VIENA vykdymo forma visiems, kas leidžia `vq/config/quality-policy.json` komandas (vartai,
// audit-director). Etalone būtent antra, privati kopija ir leido audito keliui vykdyti shell
// patikras be komandų politikos priešais jas — todėl čia yra vienintelis šio elgesio namas.

import { packageManagerExecutable, run, runShell, type CommandResult } from "./run-process.js";
import type { ResolvedQualityCheck } from "../../application/policy-governance/quality-policy.js";

/**
 * Paketų tvarkyklės vardas win32 platformoje yra `.cmd` shim'as, o ne `.exe`: `spawn("npm")`
 * be jo krenta su ENOENT. Normalizacija taikoma TIK trims žinomiems vardams — bet kokia kita
 * komanda paleidžiama tokia, kokia deklaruota politikoje.
 */
function commandForPlatform(command: string): string {
  return /^(?:npm|pnpm|yarn)$/i.test(command) ? packageManagerExecutable(command) : command;
}

/**
 * `QualityGateRunner` realizacija: `shell` forma eina per shell'ą, `spawn` forma — per spawn'ą.
 *
 * Formos NESUTAPATINAMOS sąmoningai: spawn kelias jokio shell'o nepaleidžia, tad politikos
 * uždrausti metasimboliai ten fiziškai negali nieko atlikti; jo pavertimas shell eilute grąžintų
 * būtent tą injekcijos paviršių, kurį atskira forma ir panaikina.
 */
export function runQualityCheck(
  check: ResolvedQualityCheck,
  cwd: string,
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  if (check.kind === "shell") {
    return runShell(check.display, cwd, timeoutMs, env);
  }
  return run(commandForPlatform(check.cmd), check.args, {
    cwd,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env === undefined ? {} : { env }),
  });
}
