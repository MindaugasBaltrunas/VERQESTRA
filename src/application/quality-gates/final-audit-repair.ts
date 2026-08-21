// Galutinio audito REMONTO užduotis (etalonas: AG_loop orchestrator/quality/final-audit-repair.ts).
//
// Kai tuščios eilės auditas krenta, loop'as neturi ko daryti su savimi: eilė tuščia, o kokybės
// vartai raudoni. Šis modulis iš to padaro DARBĄ — remonto užduotį, kuri praeina tą patį kelią kaip
// bet kuris kitas task'as (dispatch → vartai → terminalinis bucket'as).
//
// Trys taisyklės, kurios čia yra kontraktas:
//   1. jei remonto užduotis JAU laukia žmogaus, nauja NEIŠDUODAMA — kitaip kiekvienas ratas gamintų
//      po vieną kopiją, o žmogus rastų dešimt tų pačių užduočių;
//   2. infrastruktūros exit kodas nutraukia kelią METIMU, o ne tyliu „human-review": aplinkos
//      gedimas nėra remonto rezultatas, ir jo užvertimas kaip darbo baigties paslėptų priežastį;
//   3. `done` pasiekiamas TIK tada, kai vartai po remonto praėjo — kitu atveju užduotis keliauja
//      žmogui su tikru exit kodu žurnale.

/** Ką remonto ciklas realiai padarė. */
export type FinalAuditRepairResult = {
  dispatchCode: number;
  qualityCode: number;
  state: "done" | "human-review";
  file: string;
};

export type FinalAuditRepairCheckpoint = {
  actor: "supervisor";
  phase: string;
  status: "waiting" | "finished" | "failed";
  task_id: string;
  task_file: string;
  log_file: string;
  exit_code?: number;
  next_action: string;
};

export type FinalAuditRepairEvent = {
  task_id: string;
  to_state: string;
  phase: string;
  exit_code?: number;
  reason: string;
};

export type FinalAuditRepairPorts = {
  /** Jau laukiančios remonto užduotys žmogaus peržiūroje (bazinis vardas). */
  pendingHumanReview: () => Promise<string[]>;
  /** Užduoties failo įrašymas į `error` bucket'ą; grąžina absoliutų kelią. */
  writeTaskFile: (taskName: string, content: string) => Promise<string>;
  fingerprint: (absolutePath: string) => Promise<string>;
  recordState: (taskId: string, taskName: string, state: string, file: string, fingerprint: string) => Promise<void>;
  recordCheckpoint: (checkpoint: FinalAuditRepairCheckpoint) => Promise<void>;
  recordEvent: (event: FinalAuditRepairEvent) => Promise<void>;
  /** Vieno CLI žingsnio paleidimas; grąžina exit kodą. */
  runCommand: (args: string[]) => Promise<number>;
  /** Perkėlimas į terminalinį bucket'ą; grąžina naują kelią. */
  moveTask: (fromFile: string, state: "done" | "human-review", taskName: string) => Promise<string>;
  markStable: () => Promise<void>;
  log: (message: string) => Promise<void>;
  /** Ar exit kodas reiškia INFRASTRUKTŪROS gedimą, o ne darbo rezultatą. */
  isInfrastructureExitCode: (code: number) => boolean;
  logFilePath: (name: string) => string;
};

export const FINAL_AUDIT_REPAIR_TASK_ID = "claude-audit-repair";

/** Ar failas yra remonto užduotis (su ar be numerio: `claude-audit-repair-2.md`). */
export function isFinalAuditRepairTaskFile(baseName: string): boolean {
  return /^claude-audit-repair(?:-\d+)?\.md$/.test(baseName);
}

export class FinalAuditRepairAlreadyPendingError extends Error {
  readonly pendingFiles: string[];

  constructor(pendingFiles: string[]) {
    super(`final audit repair already pending human review: ${pendingFiles.join(", ")}`);
    this.name = "FinalAuditRepairAlreadyPendingError";
    this.pendingFiles = pendingFiles;
  }
}

/** Infrastruktūros gedimas remonto kelyje: įrašomas, tada METAMAS. */
export class FinalAuditRepairInfrastructureError extends Error {
  readonly stage: string;
  readonly exitCode: number;

  constructor(stage: string, exitCode: number, taskId: string) {
    super(`${stage} infrastructure failure exit=${exitCode} task=${taskId}`);
    this.name = "FinalAuditRepairInfrastructureError";
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

export async function processFinalAuditRepairTask(
  ports: FinalAuditRepairPorts,
  content: string,
): Promise<FinalAuditRepairResult> {
  const pending = await ports.pendingHumanReview();
  if (pending.length > 0) {
    await ports.log(`FINAL AUDIT REPAIR ALREADY PENDING HUMAN REVIEW: ${pending.join(", ")}`);
    throw new FinalAuditRepairAlreadyPendingError(pending);
  }

  const taskId = FINAL_AUDIT_REPAIR_TASK_ID;
  const taskName = `${taskId}.md`;
  const taskFile = await ports.writeTaskFile(taskName, content);

  await ports.recordState(taskId, taskName, "error", taskFile, await ports.fingerprint(taskFile));
  await ports.recordCheckpoint({
    actor: "supervisor",
    phase: "final-audit-repair",
    status: "waiting",
    task_id: taskId,
    task_file: taskFile,
    log_file: ports.logFilePath("checks-last.log"),
    next_action: "Dispatch final audit repair task",
  });
  await ports.recordEvent({ task_id: taskId, to_state: "error", phase: "final-audit-repair", reason: "final_audit_failed" });

  const failInfrastructure = async (stage: string, exitCode: number): Promise<never> => {
    await ports.recordCheckpoint({
      actor: "supervisor",
      phase: "final-audit-repair",
      status: "failed",
      task_id: taskId,
      task_file: taskFile,
      log_file: ports.logFilePath("orchestrator.log"),
      exit_code: exitCode,
      next_action: `Fix ${stage} infrastructure and restart the loop`,
    });
    await ports.recordEvent({
      task_id: taskId,
      to_state: "error",
      phase: "final-audit-repair",
      exit_code: exitCode,
      reason: `infra_abort stage=${stage} exit=${exitCode}`,
    });
    await ports.log(`FINAL AUDIT REPAIR INFRA FAILURE: stage=${stage} exit=${exitCode} task=${taskId}`);
    throw new FinalAuditRepairInfrastructureError(stage, exitCode, taskId);
  };

  const dispatchCode = await ports.runCommand(["claude-dispatch", taskFile]);
  if (ports.isInfrastructureExitCode(dispatchCode)) await failInfrastructure("dispatch", dispatchCode);
  // Vartai paleidžiami TIK po sėkmingo dispatch'o: be remonto jie duotų tą patį raudoną verdiktą,
  // o jo pakartojimas nieko nepasakytų.
  const qualityCode = dispatchCode === 0 ? await ports.runCommand(["quality-gates"]) : dispatchCode;
  if (ports.isInfrastructureExitCode(qualityCode)) await failInfrastructure("quality-gates", qualityCode);

  const state = qualityCode === 0 ? "done" : "human-review";
  const moved = await ports.moveTask(taskFile, state, taskName);

  if (state === "done") await ports.markStable();
  await ports.recordState(taskId, taskName, state, moved, await ports.fingerprint(moved));
  await ports.recordCheckpoint({
    actor: "supervisor",
    phase: state === "done" ? "done" : "human-review",
    status: "finished",
    task_id: taskId,
    task_file: moved,
    log_file: ports.logFilePath(state === "done" ? "commit.log" : "checks-last.log"),
    next_action: state === "done" ? "Final audit complete" : "Review failed final audit repair",
  });
  await ports.recordEvent({
    task_id: taskId,
    to_state: state,
    phase: "final-audit-repair",
    exit_code: qualityCode,
    reason: state === "done" ? "final_audit_repair_done" : "final_audit_repair_failed",
  });
  await ports.log(`POST-REPAIR AUDIT: dispatch=${dispatchCode} exit=${qualityCode} moved_to=${state} file=${moved}`);

  return { dispatchCode, qualityCode, state, file: moved };
}
