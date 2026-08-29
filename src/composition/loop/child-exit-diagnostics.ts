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
