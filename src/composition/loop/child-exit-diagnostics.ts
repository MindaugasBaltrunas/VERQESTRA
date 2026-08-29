// Vaiko exit diagnostika — grynas formatuotojas, kviečiamas iš `command.ts` `runChild`.
//
// Etalonas prieš 080: uodegos buvo rašomos TIK jei netuščios, tad tylus lūžis (be stderr/stdout)
// palikdavo vien "WAVE SLOT CHILD EXIT <code>" be jokios priežasties — 2026-08-29 GeoGravity
// audite tokių buvo 17 iš 35. Dabar exit kontekstas (code/duration) ir bent viena grep'inama
// eilutė lieka VISADA, net kai vaikas nieko neparašė.

const TAIL_CHAR_LIMIT = 4000;

export type ChildExitDiagnosticsInput = {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  workerId: string;
  taskId: string;
  /** Tik jei `run` rezultatas jį jau turi — porto kontraktas (CommandResult) šio lauko šiuo metu neturi. */
  signal?: string;
};

const SLOT_LOG_PATH_SEPARATOR_PATTERN = /[\\/]+/g;
/** Naudojamas, kai slot'as neturi `attempt_ref` (struktūriškai galimas net su worktree — žr. `wave-dispatch.ts`). */
const UNKNOWN_ATTEMPT_ID = "a0";

function sanitizeSlotLogSegment(segment: string): string {
  return segment.replace(SLOT_LOG_PATH_SEPARATOR_PATTERN, "_");
}

/**
 * `vq/logs/slots` failo vardas vienam worker/task/attempt trejetui — GRYNA funkcija (080-a-02):
 * kelio separatoriai sanitizuojami, kad worker/task id (paprastai jau saugūs, bet niekada
 * nerodyti struktūriškai) negalėtų sukurti kelio segmento.
 */
export function childExitSlotLogFileName(input: { workerId: string; taskId: string; attemptId?: string }): string {
  const attemptId = input.attemptId ?? UNKNOWN_ATTEMPT_ID;
  return `${[input.workerId, input.taskId, attemptId].map(sanitizeSlotLogSegment).join("-")}.log`;
}

function tailOf(label: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return `\n--- child ${label} (tail) ---\n${trimmed.slice(-TAIL_CHAR_LIMIT)}`;
}

export function formatChildExitDiagnostics(input: ChildExitDiagnosticsInput): string {
  const stderrTrimmed = input.stderr.trim();
  const stdoutTrimmed = input.stdout.trim();

  const stderrBlock = stderrTrimmed === "" ? "\n--- child stderr: EMPTY ---" : tailOf("stderr", input.stderr);
  const stdoutBlock = tailOf("stdout", input.stdout);

  const signalSuffix = input.signal === undefined ? "" : ` signal=${input.signal}`;
  const exitContextLine = `\nchild exit context: code=${input.code} duration=${input.durationMs}${signalSuffix}`;

  const nothingCollected = stderrTrimmed === "" && stdoutTrimmed === "";
  const silentLine = nothingCollected ? `\nCHILD EXIT SILENT: ${input.workerId} ${input.taskId}` : "";

  return (
    `WAVE SLOT CHILD EXIT ${input.code}: slot=${input.workerId} task=${input.taskId}` +
    stderrBlock +
    stdoutBlock +
    exitContextLine +
    silentLine
  );
}
