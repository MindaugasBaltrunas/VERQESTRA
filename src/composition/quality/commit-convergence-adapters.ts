// Commit convergence adapteriai (manual DI, LAY-2).
//
// `runCommitConvergence` (application/release-readiness/commit-convergence.ts) yra grynas
// orkestratorius: jis perleidžia project status ir converge patikrą ir grąžina telemetry įrašą.
// Šis failas duoda jam TIKRUS portus ir vieną saugų kvietimo paviršių Stop hook'ui.
//
// Kodėl atskiras failas nuo `readiness-adapters.ts`: tas rinkinys yra SKAITANTIS-ataskaitinis
// (auditas, konvergencija, įrodymo artefaktai — kiekvienas kviečiamas iš CLI komandos), o šis
// yra COMMIT'O ŠALUTINIS kelias: jis paleidžiamas automatiškai po git rašymo ir jo nesėkmė
// niekada negali paversti sėkmingo commit'o nesėkme. Sumaišius, tas „niekada nemesk" elgesys
// nutekėtų į CLI komandas, kur klaida privalo būti matoma kaip exit kodas.

import path from "node:path";
import {
  runCommitConvergence,
  type CommitConvergencePorts,
  type CommitConvergenceProjectStatus,
  type CommitConvergenceResult,
} from "../../application/release-readiness/commit-convergence.js";
import { converge } from "../../application/release-readiness/converge-check.js";
import { projectStatus } from "../../interfaces/cli/reports/project-status.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { gitHead } from "../../infrastructure/git/git-client.js";
import { convergePorts, projectStatusFs, releaseProofPorts } from "./readiness-adapters.js";

export type CommitConvergenceAdapterInput = {
  projectRoot: string;
  /** `<projectRoot>/vq` — telemetry, status išvestys, konfigai. */
  runtimeRoot: string;
  /** `<projectRoot>/AG` — task bucket'ai ir spec. Praleidus išvedama iš `projectRoot`. */
  agRoot?: string;
};

/**
 * Telemetry žurnalas: `<runtimeRoot>/state/commit-convergence.jsonl`.
 *
 * JSONL, ne JSON: kiekvienas commit'as yra ATSKIRAS įvykis, o ne naujausia būsena. Vienas
 * perrašomas JSON failas ištrintų būtent tai, dėl ko šis mechanizmas egzistuoja — ar
 * konvergencija gerėja, ar blogėja per commit'ų seką.
 */
function telemetryPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "commit-convergence.jsonl");
}

function hooksLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "hooks.log");
}

/**
 * `project-status` rezultatas suplotas iki to, ką `CommitConvergencePorts` žada: verdiktas ir
 * žmogui skaitomos priežastys.
 *
 * Į „issues" patenka DU signalai, ir abu sąmoningai: pasenęs release įrodymas (statusas
 * teigtų baigtumą, kurio užfiksuotas artefaktas nepatvirtina) ir nebaigtas darbas ne-`queue`
 * bucket'uose (`project-status` juos jau laiko likusiu darbu — `otherPendingBuckets`).
 * Eilėje laukiantys task'ai NĖRA problema: eilė su darbu yra normali būsena.
 */
async function summarizeProjectStatus(
  projectRoot: string,
  runtimeRoot: string,
  agRoot: string,
): Promise<CommitConvergenceProjectStatus> {
  const result = await projectStatus({
    fs: projectStatusFs(),
    releaseProof: releaseProofPorts(projectRoot, runtimeRoot, agRoot),
    gitHead: () => gitHead(projectRoot),
    projectRoot,
    runtimeRoot,
  });

  const issues: string[] = [];
  if (result.releaseProof.stale) {
    issues.push(`release proof stale: ${result.releaseProof.reason ?? "unknown reason"}`);
  }
  for (const [bucket, files] of Object.entries(result.otherPending)) {
    if (files !== undefined && files.length > 0) {
      issues.push(`${bucket}: ${files.length} unfinished task(s)`);
    }
  }
  return { status: issues.length === 0 ? "ok" : "issues", issues };
}

/**
 * Realūs `runCommitConvergence` portai.
 *
 * Portai PERNAUDOJA tuos pačius adapterius, kuriuos naudoja `project-status` ir `converge` CLI
 * komandos (`readiness-adapters`): jei automatinis perleidimas matytų kitokį pasaulį nei rankinė
 * komanda, telemetry nebūtų palyginama su tuo, ką operatorius pamato savo terminale.
 */
export function commitConvergencePorts(input: CommitConvergenceAdapterInput): CommitConvergencePorts {
  const { projectRoot, runtimeRoot } = input;
  const agRoot = input.agRoot ?? path.join(projectRoot, "AG");

  return {
    runProjectStatus: () => summarizeProjectStatus(projectRoot, runtimeRoot, agRoot),
    runConverge: () => converge(convergePorts, { projectRoot, runtimeRoot }),
    writeTelemetry: (record) => nodeFsAdapter.appendTextFile(telemetryPath(runtimeRoot), `${JSON.stringify(record)}\n`),
    now: () => new Date().toISOString(),
  };
}

export type CommitConvergenceRecordInput = {
  ports: CommitConvergencePorts;
  /** Žurnalo šaknis nesėkmės pastabai (`<runtimeRoot>/logs/hooks.log`). */
  runtimeRoot: string;
  /** Commit SHA; `undefined`, kai git jo neišsprendė — įrašas vis tiek rašomas. */
  commit: string | undefined;
};

/**
 * Perleidžia konvergenciją po commit'o ir NIEKADA nemeta.
 *
 * Kvietėjas yra Stop hook'as, kuris ką tik įrašė į git istoriją. Ten mesta klaida paverstų jau
 * įvykusį commit'ą „nesėkme", ir sesija būtų nustumta į human-review dėl ATASKAITOS, o ne dėl
 * darbo. Todėl nesėkmė grąžinama kaip `undefined` — bet ne tyliai: ji patenka į `hooks.log`,
 * nes tyli baigtis yra defektas.
 */
export async function recordCommitConvergence(
  input: CommitConvergenceRecordInput,
): Promise<CommitConvergenceResult | undefined> {
  const commit = input.commit ?? "unknown";
  const log = async (line: string): Promise<void> => {
    await nodeFsAdapter
      .appendTextFile(hooksLogPath(input.runtimeRoot), `[${new Date().toISOString()}] ${line}\n`)
      .catch(() => undefined);
  };

  try {
    const result = await runCommitConvergence(input.ports, { commit });
    await log(
      `commit-convergence ${commit}: project_status=${result.telemetry.projectStatus}` +
        ` converge=${result.telemetry.convergeStatus} issues=${result.telemetry.convergeIssueCount}`,
    );
    return result;
  } catch (error: unknown) {
    await log(
      `commit-convergence ${commit} NEPAVYKO: ${error instanceof Error ? error.message : String(error)}` +
        " (commit'as lieka sėkmingas)",
    );
    return undefined;
  }
}
