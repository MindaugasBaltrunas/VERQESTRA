// VQ-204 characterization (PAR-1): diagnozės dispozicijų runner'is prieš pažodinę AG_loop
// fixture kopiją. Testas tik leidžia duomenis prieš domain/diagnosis grynas funkcijas.
// Rezultatas normalizuojamas per JSON round-trip, kad `undefined` laukai (pvz. atmesto stop
// įrodymo `status`) lygintųsi su fixture'e neišreiškiamu „lauko nėra" vienodai abiejuose repo.
// Record režimo NĖRA (PAR-1).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  evaluateDeterministicDone,
  evaluateLocalDiagnosis,
  pendingAttemptChangedFiles,
  resolveDispatchSessionNonce,
  resolveEffectiveStopStatus,
  resolveNoCommitDisposition,
  type DeterministicDoneInputs,
  type LocalResultSignals,
  type NoCommitDoneInputs,
  type StopEvidence,
} from "../domain/diagnosis/dispositions.js";

type DispositionCase = {
  id: string;
  fn: string;
  input: Record<string, unknown>;
  expect: unknown;
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "diagnosis-dispositions.json",
);

const fixture: { schema_version: number; cases: DispositionCase[] } = JSON.parse(await readFile(fixturePath, "utf8"));

function invoke(dispositionCase: DispositionCase): unknown {
  const input = dispositionCase.input;
  switch (dispositionCase.fn) {
    case "evaluateDeterministicDone":
      return evaluateDeterministicDone(input as DeterministicDoneInputs);
    case "resolveNoCommitDisposition":
      return resolveNoCommitDisposition(input as NoCommitDoneInputs);
    case "evaluateLocalDiagnosis":
      return evaluateLocalDiagnosis(input as unknown as LocalResultSignals);
    case "resolveEffectiveStopStatus":
      return resolveEffectiveStopStatus(input["evidence"] as StopEvidence, input["taskId"] as string);
    case "resolveDispatchSessionNonce":
      return resolveDispatchSessionNonce(
        input as {
          envNonce: string;
          origin: StopEvidence["origin"];
          recordNonce: string;
          recordTaskId: string;
          taskId: string;
        },
      );
    case "pendingAttemptChangedFiles":
      return pendingAttemptChangedFiles(
        input as { changedFiles: string[]; dirtyPaths: string[]; windowProductPaths: string[]; windowKnown: boolean },
      );
    default:
      throw new Error(`fixture names unknown function: ${dispositionCase.fn}`);
  }
}

test("diagnosis characterization fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 25, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const dispositionCase of fixture.cases) {
  test(`diagnosis disposition: ${dispositionCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(invoke(dispositionCase) ?? null));
    const expected = dispositionCase.expect ?? null;
    assert.deepStrictEqual(actual, expected, dispositionCase.id);
  });
}
