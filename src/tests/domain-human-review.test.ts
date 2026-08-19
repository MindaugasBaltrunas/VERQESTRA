// VQ-201: human-review vartų kontraktai — approved žymos formos, kategorijų vartai su
// istoriniais false-positive regresais, changed-path variantas be žymos galiojimo.
// Elgesio atvejai perkelti iš AG_loop review-gates.test.ts branduolio.
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeChangedPathGates, analyzeHumanReviewGates } from "../domain/tasks/human-review/gates.js";

test("HUMAN-REVIEW-APPROVED suppresses gates: line-start and bullet forms, never mid-sentence", () => {
  const risky = "# Task\n\n## Tikslas\nChange oauth login and password storage.\n";
  assert.equal(analyzeHumanReviewGates(risky).requires_human_review, true);

  const approvedLine = `${risky}\nHUMAN-REVIEW-APPROVED: operatorius 2026-08-19 ok\n`;
  const lineResult = analyzeHumanReviewGates(approvedLine);
  assert.equal(lineResult.requires_human_review, false);
  assert.equal(lineResult.approved_marker, "operatorius 2026-08-19 ok");

  const approvedBullet = `${risky}\n- HUMAN-REVIEW-APPROVED: operatorius bullet forma\n`;
  assert.equal(analyzeHumanReviewGates(approvedBullet).requires_human_review, false);

  const midSentence = `${risky}\nKažkas sakė HUMAN-REVIEW-APPROVED: bet tai proza.\n`;
  assert.equal(analyzeHumanReviewGates(midSentence).requires_human_review, true, "mid-sentence marker must not count");
});

test("category gates fire on their evidence and stay quiet on known false-positive shapes", () => {
  const security = analyzeHumanReviewGates("# Task\n## Tikslas\nRotate jwt secrets.", ["src/auth/token.ts"]);
  assert.deepEqual(
    security.gates.map((gate) => gate.category),
    ["security"],
  );
  assert.deepEqual(security.gates[0]?.evidence, ["path:src/auth/token.ts", "text:security-sensitive-change"]);

  const dbFalsePositive = analyzeHumanReviewGates("# Task\n## Tikslas\nClean architecture migration of modules.");
  assert.equal(dbFalsePositive.requires_human_review, false, "code migration is not a DB migration");

  const db = analyzeHumanReviewGates("# Task\n## Tikslas\nWrite sql migrations for the users table.");
  assert.deepEqual(
    db.gates.map((gate) => gate.category),
    ["database"],
  );

  const vcs = analyzeHumanReviewGates("# Task\n## Tikslas\nRun git checkout main before merging.");
  assert.equal(vcs.requires_human_review, false, "git checkout is VCS, not commerce");

  const billing = analyzeHumanReviewGates("# Task\n## Tikslas\nImplement checkout for the store.");
  assert.deepEqual(
    billing.gates.map((gate) => gate.category),
    ["billing"],
  );

  const dependency = analyzeHumanReviewGates("# Task\n## Tikslas\nAdd a new package to the build.", ["package.json"]);
  assert.deepEqual(
    dependency.gates.map((gate) => gate.category),
    ["dependency"],
  );
  const dependencyFp = analyzeHumanReviewGates("# Task\n## Tikslas\nAdd a dependency-boundary check to CI.");
  assert.equal(dependencyFp.requires_human_review, false, "hyphenated tooling language is not package management");
});

test("changed-path gates reuse the same rules and never honour an approval marker", () => {
  const result = analyzeChangedPathGates(["src/auth/session-store.ts", "db/migrations/0001_init.sql"]);
  assert.deepEqual(
    result.gates.map((gate) => gate.category).sort(),
    ["database", "security"],
  );
  assert.equal(result.approved_marker, undefined);
});
