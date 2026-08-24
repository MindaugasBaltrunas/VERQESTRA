import assert from "node:assert/strict";
import test from "node:test";
import { gateDigestOf, gatesPassedOf } from "../application/local-integration-digests.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import { SESSION_REVIEW_CAPS } from "../application/session-review-contract.js";
import {
  projectSessionReview,
  type SessionReviewFacts,
} from "../application/session-review-projection.js";
import type { SessionGateEvidence } from "../application/ports/session-gate-evidence-port.js";
import {
  addedLinesRecord,
  at,
  ESCAPE,
  evidenceOf,
  factsOf,
  lineAt,
  manyFiles,
  MODIFIED_DIFF,
  RECORDED_AT,
  refusalOf,
  SESSION_ID,
  SOURCE_COMMIT,
  TARGET_HEAD,
  TOKEN_CANARY,
} from "./session-review-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-review-projection.test.ts` buvo 1175
 * eilučių). Čia — kas prisideda PRIE diff'o: vartų įrodymas, auditas, jų redakcija ir faktų
 * patikra prieš projektuojant. Pats snapshot'as — `session-review-projection.test.ts`; parserio
 * kraštiniai atvejai — `session-review-diff-parse.test.ts`.
 */

test("gate evidence that proves nothing about this session is reported as none", () => {
  const cases: readonly (readonly [string, SessionReviewFacts])[] = [
    ["no evidence at all", factsOf({ rawDiff: MODIFIED_DIFF })],
    [
      "evidence for another session",
      factsOf({ rawDiff: MODIFIED_DIFF, evidence: evidenceOf({ sessionId: "another-session" }) }),
    ],
    [
      "evidence for another commit",
      factsOf({ rawDiff: MODIFIED_DIFF, evidence: evidenceOf({ commit: TARGET_HEAD }) }),
    ],
    [
      "an empty gate list",
      factsOf({ rawDiff: MODIFIED_DIFF, evidence: evidenceOf({ gates: [] }) }),
    ],
  ];
  for (const [reason, facts] of cases) {
    assert.equal(projectSessionReview(facts).gates, null, reason);
  }
});

test("gate results are projected through the host's own fail-closed verdict", () => {
  const evidence = evidenceOf({
    gates: [
      { name: "readme", passed: true, status: "passed", durationMs: 1_200 },
      { name: "architecture", passed: true },
      { name: "secret", passed: true, status: "passed", durationMs: -5 },
      { name: "typecheck", passed: true, status: "passed", durationMs: 1.5 },
      { name: "test", passed: true, status: "passed", durationMs: 9_000 },
    ],
  });
  const snapshot = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF, evidence }));
  assert.ok(snapshot.gates !== null);
  assert.equal(snapshot.gates.commit, SOURCE_COMMIT);
  assert.equal(snapshot.gates.recordedAt, RECORDED_AT);
  assert.equal(snapshot.gates.digest, gateDigestOf(evidence));
  assert.deepEqual(snapshot.gates.requiredGateNames, [...REQUIRED_GATE_NAMES]);
  assert.equal(
    snapshot.gates.allRequiredPassed,
    gatesPassedOf(evidence, SOURCE_COMMIT, REQUIRED_GATE_NAMES),
  );
  assert.equal(snapshot.gates.allRequiredPassed, true);
  // Diagnostics that are absent or unusable become `null`, never a guess.
  assert.deepEqual(at(snapshot.gates.gates, 1, "gate"), {
    name: "architecture",
    passed: true,
    status: null,
    durationMs: null,
  });
  assert.equal(at(snapshot.gates.gates, 2, "gate").durationMs, null);
  assert.equal(at(snapshot.gates.gates, 3, "gate").durationMs, null);
});

test("incomplete, duplicated or failed evidence is a report that did not pass", () => {
  const incomplete: readonly (readonly [string, SessionGateEvidence])[] = [
    ["a missing required gate", evidenceOf({ gates: [{ name: "readme", passed: true }] })],
    [
      "a duplicated gate",
      evidenceOf({
        gates: [...REQUIRED_GATE_NAMES.map((name) => ({ name, passed: true })), {
          name: "readme",
          passed: true,
        }],
      }),
    ],
    [
      "one red gate",
      evidenceOf({
        gates: REQUIRED_GATE_NAMES.map((name) => ({
          name,
          passed: name !== "test",
          status: name === "test" ? ("failed" as const) : ("passed" as const),
        })),
      }),
    ],
  ];
  for (const [reason, evidence] of incomplete) {
    const snapshot = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF, evidence }));
    assert.ok(snapshot.gates !== null, reason);
    assert.equal(snapshot.gates.allRequiredPassed, false, reason);
  }
});

test("a required gate list that cannot verify anything is refused", () => {
  for (const requiredGateNames of [[], ["readme", "readme"]]) {
    const error = refusalOf(() => projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      requiredGateNames,
    })));
    assert.equal(error.code, "internal_error");
    assert.equal(error.message, "Session review required gate names are invalid");
  }
});

test("an audit is reported only when it describes this commit", () => {
  assert.equal(projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF })).audit, null);
  assert.equal(
    projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      audit: { status: "clean", findings: [], ranAt: RECORDED_AT, commit: TARGET_HEAD },
    })).audit,
    null,
  );

  const findings = Array.from({ length: 150 }, (_unused, index) => ({
    severity: "warning" as const,
    rule: `rule-${index}`,
    path: index % 2 === 0 ? `src/file-${index}.ts` : null,
    message: `finding ${index}`,
  }));
  const snapshot = projectSessionReview(factsOf({
    rawDiff: MODIFIED_DIFF,
    // "Clean" alongside findings is a contradiction; the findings win.
    audit: { status: "clean", findings, ranAt: RECORDED_AT, commit: SOURCE_COMMIT },
  }));
  assert.ok(snapshot.audit !== null);
  assert.equal(snapshot.audit.status, "findings");
  assert.equal(snapshot.audit.findings.length, SESSION_REVIEW_CAPS.maxAuditFindings);
  assert.equal(snapshot.audit.totalFindingCount, 150);
  assert.equal(snapshot.audit.ranAt, RECORDED_AT);
  assert.equal(at(snapshot.audit.findings, 1, "finding").path, null);

  const escaping = refusalOf(() => projectSessionReview(factsOf({
    rawDiff: MODIFIED_DIFF,
    audit: {
      status: "findings",
      findings: [{ severity: "error", rule: "boundary", path: "../outside.ts", message: "escaped" }],
      ranAt: RECORDED_AT,
      commit: SOURCE_COMMIT,
    },
  })));
  assert.equal(escaping.message, "Repository reported a path outside the working tree");
});

test("audit findings are redacted, because the AG audit writes host paths into them", () => {
  const message = String.raw`Secret found in D:\React\AG_loop\secret.txt` +
    ` while reading GITHUB_TOKEN=${TOKEN_CANARY}`;
  const snapshot = projectSessionReview(factsOf({
    rawDiff: MODIFIED_DIFF,
    audit: {
      status: "findings",
      findings: [{ severity: "error", rule: "secret", path: "src/app.ts", message }],
      ranAt: RECORDED_AT,
      commit: SOURCE_COMMIT,
    },
  }));
  assert.ok(snapshot.audit !== null);
  const projected = at(snapshot.audit.findings, 0, "finding");
  assert.equal(projected.message.includes("AG_loop"), false);
  assert.equal(projected.message.includes(TOKEN_CANARY), false);
  assert.match(projected.message, /\[PATH\]/);
  assert.match(projected.message, /\[REDACTED\]/);
  assert.equal(projected.path, "src/app.ts");
});

test("terminal control sequences committed into a file never reach the reader", () => {
  const snapshot = projectSessionReview(factsOf({
    rawDiff: addedLinesRecord("src/app.ts", 1, `${ESCAPE}[31mred${ESCAPE}[0m`),
  }));
  const text = lineAt(snapshot, 0, 0, 0).text;
  assert.equal(text, "red");
  assert.equal(text.includes(ESCAPE), false);
});

test("branch and commit facts are validated before anything is projected", () => {
  const unusable: readonly (readonly [string, Partial<SessionReviewFacts>])[] = [
    ["a branch that would be read as an option", { sourceBranch: "-oops" }],
    ["a branch that would be read as a range", { sourceBranch: "a..b" }],
    ["a target branch that would be read as an option", { targetBranch: "--upstream" }],
    ["a commit that is not an object id", { sourceCommit: "zz" }],
    ["a head that is not an object id", { targetHead: "b".repeat(39) }],
  ];
  for (const [reason, overrides] of unusable) {
    const error = refusalOf(() => projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      ...overrides,
    })));
    assert.equal(error.code, "internal_error", reason);
  }
});

/**
 * An absolute host location ANYWHERE in a string, not only at its start: a
 * message reading `checked /home/operator/AG_loop/README.md` leaks the same home
 * directory as a value that begins with one, and an anchored check would pass it.
 */
const ABSOLUTE_LOCATION = /(^|[\s"'(])([A-Za-z]:[\\/]|\/(?:[\w.-]+\/){2,})/;

/**
 * The DTO is walked twice, because its two halves carry opposite obligations.
 *
 * Everything the host DESCRIBES — the changed file list, the git fingerprint,
 * the gate report and the audit — is host-authored prose about the work, so it
 * must hold no absolute location at all.
 *
 * `diff.files[].hunks[].lines[].text` is deliberately exempt, and the exemption
 * is asserted rather than assumed below. That field carries repository CONTENT
 * verbatim; a committed line is free to contain an absolute path, and rewriting
 * it would misrepresent what the operator is being asked to approve — the very
 * thing `session-review-projection.ts` refuses to do. Its protection is the
 * local-plane routing and the control-sequence strip, not a path filter.
 */
test("the snapshot carries no host location and no integration handle", () => {
  const committedPath = `const root = "/home/operator/AG_loop/README.md";`;
  const snapshot = projectSessionReview(factsOf({
    rawDiff: addedLinesRecord("src/app.ts", 1, committedPath),
    evidence: evidenceOf(),
    audit: {
      status: "findings",
      findings: [{
        severity: "warning",
        rule: "readme",
        path: "src/app.ts",
        message: String.raw`checked D:\React\AG_loop\README.md and /home/operator/AG_loop/x.md`,
      }],
      ranAt: RECORDED_AT,
      commit: SOURCE_COMMIT,
    },
  }));
  const carried = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

  const forbiddenKeys = ["integrationId", "expiresAt", "repositoryRoot", "worktreePath", "token"];
  const visitKeys = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const nested of value) visitKeys(nested);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        assert.equal(forbiddenKeys.includes(key), false, `${key} reached the DTO`);
        visitKeys(nested);
      }
    }
  };
  visitKeys(carried);

  const visitDescription = (value: unknown): void => {
    if (typeof value === "string") {
      assert.doesNotMatch(value, ABSOLUTE_LOCATION, "a host location reached the DTO");
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) visitDescription(nested);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) visitDescription(nested);
    }
  };
  // The walk must not be vacuous: both optional reports are present, and the
  // audit message really did carry two host locations into the redaction.
  assert.ok(snapshot.gates !== null && snapshot.audit !== null);
  assert.equal(at(snapshot.audit.findings, 0, "finding").message, "checked [PATH] and [PATH]");
  for (const branch of ["changedFiles", "git", "gates", "audit"]) {
    visitDescription(carried[branch]);
  }
  assert.equal(snapshot.sessionId, SESSION_ID);
  assert.doesNotMatch(snapshot.sessionId, ABSOLUTE_LOCATION);

  // The exemption is real work, not an untested loophole: the committed line
  // still reaches the reader exactly as the repository holds it, and it is a
  // value the rule above would have refused.
  assert.equal(lineAt(snapshot, 0, 0, 0).text, committedPath);
  assert.match(committedPath, ABSOLUTE_LOCATION);
});

test("the projection is pure: the same facts produce the same snapshot", () => {
  const facts = factsOf({
    rawDiff: manyFiles(3, 5),
    evidence: evidenceOf(),
    audit: {
      status: "findings",
      findings: [{ severity: "info", rule: "readme", path: null, message: "looked fine" }],
      ranAt: RECORDED_AT,
      commit: SOURCE_COMMIT,
    },
  });
  assert.deepStrictEqual(projectSessionReview(facts), projectSessionReview(facts));
});

/**
 * A record whose instant cannot be read is a record whose age cannot be judged,
 * and both of these are only worth as much as the moment they were taken. The
 * outcome is `null` — "no trustworthy record" — rather than a refusal: an
 * unreadable timestamp says nothing about the diff the operator is reading.
 */
test("evidence and audit runs whose instant cannot be read are reported as none", () => {
  const unreadable = [
    "vakar",
    "2026-08-11",
    "2026-08-11 10:00:00",
    // Well-formed but not a real instant: both halves of the check matter.
    "2026-13-40T99:99:99Z",
    "",
  ];
  for (const recordedAt of unreadable) {
    const snapshot = projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      evidence: evidenceOf({ recordedAt }),
    }));
    assert.equal(snapshot.gates, null, recordedAt);
  }
  for (const ranAt of unreadable) {
    const snapshot = projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      audit: { status: "findings", findings: [], ranAt, commit: SOURCE_COMMIT },
    }));
    assert.equal(snapshot.audit, null, ranAt);
  }

  // The offsets a host really records are readable, and are reported.
  for (const recordedAt of ["2026-08-11T10:00:00Z", "2026-08-11T13:00:00+03:00"]) {
    const snapshot = projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      evidence: evidenceOf({ recordedAt }),
    }));
    assert.ok(snapshot.gates !== null, recordedAt);
    assert.equal(snapshot.gates.recordedAt, recordedAt);
  }
});
