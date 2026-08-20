// Tokenizer-unfriendly-syntax signalas (etalono task 0042, WBR VQ-305): canary task'as, kurio
// kompiliuotas kūnas sumažėjo chars, bet ne tokenais, lyginant su control arm — būtent tas
// atvejis, kurio chars-only A/B (compression-cohorts.ts) pats nemato.
//
// Atskiras failas, o ne compression-cohorts.ts priedas: priklausomybė lieka vienkryptė —
// compression-cohorts importuoja iš čia, šis failas iš jo neimportuoja nieko (arm assignment
// ateina struktūriškai tipizuotu parametru).

/** Join-relevant `PostRunTruthRow` poaibis (post-run-truth-join — VQ-305 3/3-e), deklaruotas
 *  lokaliai, kad šis modulis neimportuotų aukštyn. */
export type CohortPostRunRow = { task_id: string; raw_chars: number; compiled_chars: number; input_tokens: number };

/** One (feature, task) pair whose compiled body shrank in chars but not in tokens. */
export type TokenizerUnfriendlySignal = {
  feature: string;
  taskId: string;
  rawChars: number;
  compiledChars: number;
  inputTokens: number;
  controlMedianInputTokens: number;
};

/** Arm klasifikacijos laukai, kurių šiam moduliui reikia — struktūriškai tenkina
 *  attempt-identity-join `ArmAssignment`, importo nereikia. */
export type TokenizerSignalArmAssignment = {
  assignmentArm: "canary" | "control";
  features: readonly string[];
};

/**
 * Mediana su lyginio ilgio vidurkinimu — ta pati konvencija kaip kitur analitikoje
 * (compression-cohorts importuoja ŠIĄ kopiją, o ne laiko savo, tad du failai apibrėžimu
 * išsiskirti negali).
 */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Pažymi canary task'us, kurie sumažėjo chars (`compiled_chars < raw_chars` — pati size guard
 * taisyklė), bet ne tokenais (`input_tokens` ties/virš control medianos). Vartuojama per
 * `minControlSample` išmatuotų control eilučių (paduok `COHORT_MIN_SAMPLE`), atspindint tą
 * pačią `insufficientSample` filosofiją.
 */
export function findTokenizerUnfriendlySignals(
  assignments: ReadonlyMap<string, TokenizerSignalArmAssignment>,
  postRunRows: readonly CohortPostRunRow[],
  minControlSample: number,
): TokenizerUnfriendlySignal[] {
  const postRunByTask = new Map<string, CohortPostRunRow>();
  for (const row of postRunRows) {
    const taskId = row.task_id.trim();
    if (taskId) postRunByTask.set(taskId, row);
  }

  const controlInputTokens: number[] = [];
  for (const [taskId, assignment] of assignments) {
    if (assignment.assignmentArm !== "control") continue;
    const row = postRunByTask.get(taskId);
    if (row) controlInputTokens.push(row.input_tokens);
  }
  if (controlInputTokens.length < minControlSample) return [];
  const controlMedian = median(controlInputTokens);
  if (controlMedian === undefined) return [];

  const signals: TokenizerUnfriendlySignal[] = [];
  for (const [taskId, assignment] of assignments) {
    if (assignment.assignmentArm !== "canary") continue;
    const row = postRunByTask.get(taskId);
    if (!row) continue;
    if (!(row.compiled_chars < row.raw_chars)) continue;
    if (!(row.input_tokens >= controlMedian)) continue;
    // Vienas signalas per skirtingą feature — ta pati atribucija kaip `featureBreakdown`.
    for (const feature of new Set(assignment.features)) {
      signals.push({
        feature,
        taskId,
        rawChars: row.raw_chars,
        compiledChars: row.compiled_chars,
        inputTokens: row.input_tokens,
        controlMedianInputTokens: controlMedian,
      });
    }
  }
  return signals.sort((left, right) => left.feature.localeCompare(right.feature) || left.taskId.localeCompare(right.taskId));
}
