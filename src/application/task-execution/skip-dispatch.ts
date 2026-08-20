/**
 * Pre-dispatch work-evidence gate (etalono task 1187).
 *
 * Eilės task'as, kurio deliverable jau guli branch istorijoje, iki šio varto vis tiek gaudavo
 * pilną LLM sesiją: po bet kurio task-failus liečiančio commit'o bangos snapshot'as
 * invaliduojasi, `skip-completed` įrašas dingsta, ir loop'as persitikrina brangiausiu įmanomu
 * būdu. Tą pačią išvadą duoda `git log` su TA PAČIA work-evidence konvencija, kurią jau
 * naudoja clean-tree diagnozė (`verify-task.ts`) ir bangos resume kelias.
 *
 * Vartai turi tris nedalomas savybes:
 *
 *   1. ĮRODYMAS YRA TRIGGER'IS, NE PRIĖMIMAS. Rastas commit'as praleidžia tik LLM sesiją;
 *      deklaruoti checks vykdomi per ESAMUS `quality-gates` vartus, ir tik jiems žaliems
 *      task'as užsidaro. Vartams kritus grįžtama į įprastą dispatch/diagnose/repair kelią —
 *      tylaus `done` čia nėra.
 *   2. BE ĮRODYMO — NULINIS STEBIMAS PĖDSAKAS. Nesant commit'o vartai nerašo nė vienos log
 *      eilutės, žurnalo įrašo ar CLI kvietimo ir `productDirtyCount` net neklausia; lieka tik
 *      dvi read-only git užklausos. Task'as be įrodymo dispatch'inamas lygiai taip pat, kaip
 *      iki šio varto atsiradimo.
 *   3. DETERMINISTIŠKUMAS. Sprendimas yra grynos funkcijos `resolveSkipDispatch` reikšmė:
 *      tie patys įėjimai (tas pats sha, ta pati medžio būsena) visada duoda tą patį sprendimą.
 *
 * SLUOKSNIO RIBA: kaip ir kiti `task-execution` use case'ai, šis modulis nevykdo nei git, nei
 * FS operacijų tiesiogiai ir neatlieka terminalinių bucket perėjimų — jis grąžina deskriptorių,
 * o perėjimą taiko `run-coordinator.ts`.
 */
import type { TaskRunPorts } from "./run-coordinator-ports.js";
import type { TaskRunState } from "./task-run-state.js";

/** Kodėl įrodymu grįstas praleidimas netaikomas. Reikšmė yra vidinė, į logus nepatenka. */
export type DispatchReason = "not-a-git-repository" | "no-work-evidence" | "dirty-tree";

export type SkipDispatchDecision =
  | { kind: "dispatch"; reason: DispatchReason }
  | { kind: "skip"; commit: string };

/** Deterministinio sprendimo įėjimai; laukų nebuvimas reiškia „neklausta" (žr. `probeWorkEvidence`). */
export type WorkEvidenceProbe = {
  isRepository: boolean;
  workEvidenceCommit?: string;
  productDirtyCount?: number;
};

/**
 * Vienintelė praleidimo taisyklė. Griežtėjimo tvarka yra tyčinė: ne-git projekte įrodymo
 * sąvokos apskritai nėra, o purvinas medis reiškia, kad be commit'o egzistuoja darbas, kurio
 * nei `quality-gates`, nei istorija dar neįvertino — abu atvejai grąžinami į įprastą kelią.
 *
 * `workEvidenceCommit` čia visada yra PRODUKTO darbo commit'as (`committedProductWorkShaFor`):
 * tvarkomasis `chore(AG/tasks)` commit'as task'o numerį mini, bet deliverable'o neneša.
 */
export function resolveSkipDispatch(probe: WorkEvidenceProbe): SkipDispatchDecision {
  if (!probe.isRepository) {
    return { kind: "dispatch", reason: "not-a-git-repository" };
  }
  const commit = probe.workEvidenceCommit?.trim();
  if (!commit) {
    return { kind: "dispatch", reason: "no-work-evidence" };
  }
  if ((probe.productDirtyCount ?? 0) > 0) {
    return { kind: "dispatch", reason: "dirty-tree" };
  }
  return { kind: "skip", commit };
}

/**
 * Įrodymo surinkimas per git port'ą. Klausimai užduodami tik tol, kol jie dar gali pakeisti
 * sprendimą — tai ir yra „be įrodymo pėdsako nėra": be commit'o `productDirtyCount` (t. y.
 * `git status`) neiškviečiamas.
 *
 * SVARBU KVIETIMO VIETAI: įrodymo intervalą riboja šio task'o `task-start-status.json`
 * baseline, tad probe privalo įvykti PRIEŠ tai, kai naujas run'as tą baseline perrašo į
 * dabartinį HEAD. Po perrašymo intervalas yra tuščias (`HEAD..HEAD`) ir ankstesnio bandymo
 * commit'as tampa nematomas.
 */
export async function probeWorkEvidence(state: TaskRunState, ports: TaskRunPorts): Promise<SkipDispatchDecision> {
  const isRepository = await ports.git.isRepository();
  if (!isRepository) {
    return resolveSkipDispatch({ isRepository });
  }
  const workEvidenceCommit = await ports.git.committedProductWorkShaFor(state.taskId);
  if (!workEvidenceCommit?.trim()) {
    return resolveSkipDispatch({ isRepository, ...(workEvidenceCommit !== undefined ? { workEvidenceCommit } : {}) });
  }
  return resolveSkipDispatch({
    isRepository,
    workEvidenceCommit,
    productDirtyCount: await ports.git.productDirtyCount(),
  });
}

export type SkipDispatchOutcome =
  | { kind: "already-implemented"; commit: string }
  | { kind: "dispatch"; qualityGateExit: number }
  | { kind: "infrastructure"; exitCode: number };

/**
 * Antra vartų pusė: įrodymas jau yra, belieka jį patikrinti deklaruotais checks.
 *
 * `quality-gates` čia kviečiamas tuo pačiu būdu, kaip `verify-task.ts` — antro vartų varianto
 * nekuriama. Kritusių vartų baigtis skiriasi lygiai taip pat, kaip ten (etalono task 0053):
 *   - task'o gedimas -> `dispatch`: įprastas preflight/dispatch/diagnose kelias, kuris tuos
 *     pačius vartus paleis dar kartą ir verdiktą priims ten, kur ta klasifikacija gyvena;
 *   - infrastruktūros exit (pasenęs dist, užrakintas failas, usage limitas, timeout) ->
 *     `infrastructure`: aplinkos gedimas liečia kiekvieną eilės task'ą, tad pigiausias kelias
 *     neturi virsti brangiausiu — LLM sesija tokiu atveju sudegtų be jokios informacijos.
 */
export async function confirmSkippedDispatch(
  state: TaskRunState,
  ports: TaskRunPorts,
  commit: string,
): Promise<SkipDispatchOutcome> {
  await ports.log.write(`TASK SKIP-DISPATCH: ${state.taskId} work-evidence commit=${commit}`);
  const qualityGateExit = await ports.cli.run(["quality-gates"]);

  if (qualityGateExit !== 0 && ports.failure.isInfrastructureExit(qualityGateExit)) {
    await ports.journal.recordPhaseFailure(state.taskId, "quality-gates", qualityGateExit, "");
    return { kind: "infrastructure", exitCode: qualityGateExit };
  }

  if (qualityGateExit !== 0) {
    await ports.journal.recordEvent({
      task_id: state.taskId,
      to_state: "skip-dispatch",
      phase: "skip-dispatch",
      exit_code: qualityGateExit,
      reason: `skip_dispatch_rejected commit=${commit} quality_gates_failed=${qualityGateExit}`,
    });
    await ports.log.write(
      `TASK SKIP-DISPATCH REJECTED: ${state.taskId} quality_gates_failed=${qualityGateExit} — dispatching`,
    );
    return { kind: "dispatch", qualityGateExit };
  }

  // `to_state` čia nėra bucket'as — task'as dar niekur nepajudėjo. Įrašas egzistuoja tam, kad
  // status ir patikimumo ataskaitos matytų sutaupytą dispatch'ą be jokio naujo store;
  // terminalinį perėjimą atskiru įrašu užfiksuos `applyTerminal`.
  await ports.journal.recordEvent({
    task_id: state.taskId,
    to_state: "skip-dispatch",
    phase: "skip-dispatch",
    exit_code: 0,
    reason: `skip_dispatch dispatch_skipped=1 commit=${commit} quality_gates=0`,
  });
  return { kind: "already-implemented", commit };
}
