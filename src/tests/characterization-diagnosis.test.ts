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
  evaluateRuntimeOversizeDisposition,
  pendingAttemptChangedFiles,
  resolveDispatchSessionNonce,
  resolveEffectiveStopStatus,
  resolveNoCommitDisposition,
  resolveNoCommitReviewReason,
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
    case "resolveNoCommitReviewReason":
      return resolveNoCommitReviewReason(input as NoCommitDoneInputs);
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

// Task 141-b: dvi baigtys, kurios iki šiol dalinosi viena „clean tree" priežastimi, turi būti
// atskiriamos viena nuo kitos — operatorius, siunčiamas ieškoti dingusio darbo, jo neranda,
// nes darbas guli medyje ir trūksta tik commit'o.
test("no-commit review reason: darbo nebuvo vs. darbas yra, bet neužcommit'intas", () => {
  const base = { hasAlreadyImplementedMarker: true, hasWorkEvidence: false } as const;
  const noWrites = resolveNoCommitReviewReason({ ...base, productDirtyCount: 0, writeActivity: "no-writes" });
  const dirtyWrites = resolveNoCommitReviewReason({ ...base, productDirtyCount: 2, writeActivity: "wrote" });

  assert.equal(noWrites, "executor made no write-tool calls");
  assert.match(dirtyWrites, /stop hook did not commit/);
  assert.notEqual(dirtyWrites, noWrites);
  // Nė viena iš dviejų priežasčių nebekartoja „dingusio deliverable" versijos.
  assert.doesNotMatch(noWrites, /clean tree without work evidence/);
  assert.doesNotMatch(dirtyWrites, /clean tree without work evidence/);
});

// Task 066-a-02 (GeoGravity 1178/7): evaluateRuntimeOversizeDisposition nėra etalono fixture'e
// (naujas VERQESTRA sprendimas, ne AG_loop elgesys), tad testuojamas tiesiogiai, ne per PAR-1
// characterization runner'į.
test("runtime-oversize disposition: timeout x1 -> repair", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({ exitCode: 124, repeatedSignatureAttempts: 1, isDivisible: true }),
    "repair",
  );
});

test("runtime-oversize disposition: timeout x2 same signature, divisible -> split", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({ exitCode: 124, repeatedSignatureAttempts: 2, isDivisible: true }),
    "split",
  );
});

test("runtime-oversize disposition: timeout x2 same signature, not divisible -> human-review", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({ exitCode: 124, repeatedSignatureAttempts: 2, isDivisible: false }),
    "human-review",
  );
});

test("runtime-oversize disposition: non-timeout exit code without raw overrun -> repair", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({ exitCode: 1, repeatedSignatureAttempts: 3, isDivisible: true }),
    "repair",
  );
});

test("runtime-oversize disposition: raw tokens over 1.2x ceiling x1 -> repair", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({
      exitCode: 0,
      repeatedSignatureAttempts: 1,
      isDivisible: true,
      rawTokensUsed: 25_500_000,
      rawTokenCeiling: 10_000_000,
    }),
    "repair",
  );
});

test("runtime-oversize disposition: raw tokens over 1.2x ceiling x2, divisible -> split", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({
      exitCode: 0,
      repeatedSignatureAttempts: 2,
      isDivisible: true,
      rawTokensUsed: 25_500_000,
      rawTokenCeiling: 10_000_000,
    }),
    "split",
  );
});

test("runtime-oversize disposition: raw tokens over 1.2x ceiling x2, not divisible -> human-review", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({
      exitCode: 0,
      repeatedSignatureAttempts: 2,
      isDivisible: false,
      rawTokensUsed: 25_500_000,
      rawTokenCeiling: 10_000_000,
    }),
    "human-review",
  );
});

test("runtime-oversize disposition: raw tokens within 1.2x ceiling, repeated -> repair (no signal)", () => {
  assert.equal(
    evaluateRuntimeOversizeDisposition({
      exitCode: 0,
      repeatedSignatureAttempts: 3,
      isDivisible: true,
      rawTokensUsed: 11_000_000,
      rawTokenCeiling: 10_000_000,
    }),
    "repair",
  );
});
