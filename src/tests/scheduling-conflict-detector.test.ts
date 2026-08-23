// VQ-303: conflict-detector — rašymo aibės ir lygiagretumo verdiktas.
//
// Iškelta iš `scheduling-waves` 2026-08-23, kai tas failas peržengė 500 eilučių vartus. Riba
// natūrali: čia sprendžiama, ar DU task'ai gali dirbti vienu metu, o ne kokia yra bangos tvarka.
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWriteScopePath,
  computeTaskWriteSet,
  evaluateWriteSetIndependence,
} from "../application/scheduling/index.js";

test("classifyWriteScopePath: order of rules is the contract", () => {
  assert.deepEqual(classifyWriteScopePath("src/app.ts"), { kind: "file", scope: "src/app.ts" });
  assert.deepEqual(classifyWriteScopePath("src/utils"), { kind: "directory", scope: "src/utils" });
  assert.deepEqual(classifyWriteScopePath("src/utils/"), { kind: "directory", scope: "src/utils" });
  assert.deepEqual(classifyWriteScopePath("src/**/*.ts"), { kind: "glob", scope: "src/**/*.ts" });
  assert.deepEqual(classifyWriteScopePath("prisma/migrations/0001_init.sql"), {
    kind: "migration-chain",
    scope: "prisma/migrations/0001_init.sql",
  });
  assert.deepEqual(classifyWriteScopePath("dist/index.js"), { kind: "generated", scope: "dist/index.js" });
});

test("computeTaskWriteSet: evidence gaps and deterministic fingerprint", () => {
  const clean = computeTaskWriteSet({ task_id: "0001", allowed_paths: ["src/a.ts", "src/a.ts", "docs/"] });
  assert.equal(clean.determinate, true);
  assert.equal(clean.entries.length, 2, "duplicate paths dedupe");
  assert.match(clean.write_set_hash, /^ws1:[0-9a-f]{16}$/);
  assert.deepEqual(clean, computeTaskWriteSet({ task_id: "0001", allowed_paths: ["docs/", "src/a.ts"] }));

  const empty = computeTaskWriteSet({ task_id: "0002" });
  assert.equal(empty.determinate, false);
  assert.deepEqual(empty.gaps.map((gap) => gap.code), ["no-declared-scope"]);

  const wildcard = computeTaskWriteSet({ task_id: "0003", allowed_paths: ["src/**"] });
  assert.ok(wildcard.gaps.some((gap) => gap.code === "wildcard-scope"));

  const traversal = computeTaskWriteSet({ task_id: "0004", allowed_paths: ["../outside.ts"] });
  assert.ok(traversal.gaps.some((gap) => gap.code === "unresolvable-scope"));

  const symbolsOnly = computeTaskWriteSet({ task_id: "0005", write_symbols: ["src/a.ts#run"] });
  assert.ok(
    symbolsOnly.gaps.some((gap) => gap.code === "no-declared-scope"),
    "identity entries alone never count as a declared path scope",
  );

  const unverified = computeTaskWriteSet({
    task_id: "0006",
    allowed_paths: ["src/a.ts"],
    unverified_contract_paths: ["src/index.ts"],
  });
  assert.ok(unverified.gaps.some((gap) => gap.code === "unverified-contract"));
  assert.equal(unverified.determinate, false);
});

test("evaluateWriteSetIndependence: only clean, disjoint write sets parallelize", () => {
  const left = computeTaskWriteSet({ task_id: "0001", allowed_paths: ["src/moduleA/"] });
  const right = computeTaskWriteSet({ task_id: "0002", allowed_paths: ["src/moduleB/"] });
  const verdict = evaluateWriteSetIndependence(left, right);
  assert.equal(verdict.independent, true);
  assert.match(verdict.verdict_hash, /^iv1:[0-9a-f]{16}$/);
  assert.equal(verdict.verdict_hash, evaluateWriteSetIndependence(right, left).verdict_hash, "verdict is symmetric");

  const overlapping = evaluateWriteSetIndependence(
    left,
    computeTaskWriteSet({ task_id: "0003", allowed_paths: ["src/moduleA/inner.ts"] }),
  );
  assert.equal(overlapping.independent, false);
  assert.equal(overlapping.conflicts.length, 1);
  assert.equal(overlapping.conflicts[0]?.kind, "directory");

  const sameTask = evaluateWriteSetIndependence(left, computeTaskWriteSet({ task_id: "0001", allowed_paths: ["docs/x.md"] }));
  assert.equal(sameTask.independent, false, "the same task can never occupy two workers");
  assert.equal(sameTask.conflicts.length, 0, "same-task refusal is not a scope conflict");

  const gapped = evaluateWriteSetIndependence(left, computeTaskWriteSet({ task_id: "0004" }));
  assert.equal(gapped.independent, false, "an evidence gap on either side forces serial execution");
  assert.deepEqual(gapped.evidence_gaps.map((gap) => gap.task_id), ["0004"]);

  const migrations = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0005", allowed_paths: ["db/migrations/0001_a.sql"] }),
    computeTaskWriteSet({ task_id: "0006", allowed_paths: ["db/migrations/0002_b.sql"] }),
  );
  assert.equal(migrations.independent, false, "migration chains serialize globally even without path overlap");
  assert.equal(migrations.conflicts[0]?.kind, "migration-chain");
});

test("evaluateWriteSetIndependence: identity families compare exactly and never cross dimensions", () => {
  const symbolLeft = computeTaskWriteSet({
    task_id: "0001",
    allowed_paths: ["src/a/"],
    write_symbols: ["src/shared.ts#run"],
  });
  const symbolRight = computeTaskWriteSet({
    task_id: "0002",
    allowed_paths: ["src/b/"],
    write_symbols: ["src/shared.ts#run"],
  });
  const sameSymbol = evaluateWriteSetIndependence(symbolLeft, symbolRight);
  assert.equal(sameSymbol.independent, false);
  assert.equal(sameSymbol.conflicts[0]?.kind, "symbol");

  const crossDimension = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0003", allowed_paths: ["src/a/"], contracts: ["pkg#api"] }),
    computeTaskWriteSet({ task_id: "0004", allowed_paths: ["src/b/"], write_symbols: ["pkg#api"] }),
  );
  assert.equal(crossDimension.independent, true, "a contract and a symbol with the same name are different dimensions");
});
