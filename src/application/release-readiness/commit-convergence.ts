// Commit convergence use-case (openspec/changes/verqestra-backlog-v1, backlog eilutė
// „Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su telemetry
// įrašu"). Po commit'o perleidžia project status ir converge patikrą per portus ir grąžina
// telemetry įrašą. Šis failas — TIK orkestracija, jokio IO: abi patikros ir telemetry rašymas
// ateina per CommitConvergencePorts; kompozicija (atskiras task'as) suriša juos su realiu
// project-status/converge/git wiring'u ir Stop hook'u.

import type { ConvergeResult } from "./converge-check.js";

export type CommitConvergenceProjectStatus = {
  status: "ok" | "issues";
  issues: string[];
};

export type CommitConvergenceTelemetry = {
  commit: string;
  /** Laikrodžio ISO žyma — ateina per `ports.now()`, kad use-case liktų deterministinis. */
  at: string;
  projectStatus: "ok" | "issues";
  convergeStatus: ConvergeResult["status"];
  convergeIssueCount: number;
};

export type CommitConvergenceResult = {
  status: CommitConvergenceProjectStatus;
  converge: ConvergeResult;
  telemetry: CommitConvergenceTelemetry;
};

export type CommitConvergenceInput = {
  /** Commit'o identifikatorius (SHA), su kuriuo susietas telemetry įrašas. */
  commit: string;
};

export type CommitConvergencePorts = {
  /** Perleidžia project status generavimą/patikrą; adapteris suploja rezultatą į šią formą. */
  runProjectStatus(): Promise<CommitConvergenceProjectStatus>;
  /** Perleidžia converge patikrą (application/release-readiness/converge-check.ts rezultatas). */
  runConverge(): Promise<ConvergeResult>;
  /** Rašo telemetry įrašą; kvietėjas sprendžia, kur (failas, žurnalas, event bus). */
  writeTelemetry(record: CommitConvergenceTelemetry): Promise<void>;
  /** Laikrodis — ISO žyma telemetry įrašui. */
  now(): string;
};

/**
 * Po commit'o perleidžia project status ir converge patikrą per portus ir grąžina telemetry
 * įrašą. Telemetry rašomas VISADA — tiek kai converge suartėjęs, tiek kai ne: nesuartėjęs
 * converge yra stebėsenos signalas, ne priežastis nutylėti įrašą.
 */
export async function runCommitConvergence(
  ports: CommitConvergencePorts,
  input: CommitConvergenceInput,
): Promise<CommitConvergenceResult> {
  const status = await ports.runProjectStatus();
  const converge = await ports.runConverge();
  const telemetry: CommitConvergenceTelemetry = {
    commit: input.commit,
    at: ports.now(),
    projectStatus: status.status,
    convergeStatus: converge.status,
    convergeIssueCount: converge.issues.length,
  };
  await ports.writeTelemetry(telemetry);
  return { status, converge, telemetry };
}
