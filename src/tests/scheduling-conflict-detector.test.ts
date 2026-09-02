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
import { allowedPaths } from "../domain/tasks/allowed-paths.js";

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
  assert.match(clean.write_set_hash, /^ws3:[0-9a-f]{16}$/);
  assert.deepEqual(clean, computeTaskWriteSet({ task_id: "0001", allowed_paths: ["docs/", "src/a.ts"] }));

  const empty = computeTaskWriteSet({ task_id: "0002" });
  assert.equal(empty.determinate, false);
  assert.deepEqual(empty.gaps.map((gap) => gap.code), ["no-declared-scope"]);

  const wildcard = computeTaskWriteSet({ task_id: "0003", allowed_paths: ["**/x.ts"] });
  assert.ok(wildcard.gaps.some((gap) => gap.code === "wildcard-scope"));

  const traversal = computeTaskWriteSet({ task_id: "0004", allowed_paths: ["../outside.ts"] });
  assert.ok(traversal.gaps.some((gap) => gap.code === "unresolvable-scope"));

  // Regresija (2026-09-01 GeoGravity orchestrator.log): bullet pagrindime turėtas `..`
  // (traversal minėjimas, ne kelias) nebeturi virsti "unresolvable-scope" spraga — jis
  // niekada nepasiekia allowed_paths, nes allowedPaths() ima tik pirmą backtick tokeną.
  const justificationDotDot = computeTaskWriteSet({
    task_id: "1248",
    allowed_paths: allowedPaths(
      "# Task\n\n## Failai\nLeidžiama:\n- `modules/viewer-3d-module/tests/` — `..` traversal + projectId regresijos\n",
    ),
  });
  assert.deepEqual(justificationDotDot.entries.map((entry) => entry.scope), ["modules/viewer-3d-module/tests"]);
  assert.ok(!justificationDotDot.gaps.some((gap) => gap.code === "unresolvable-scope"));

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

test("computeTaskWriteSet: wildcard-scope gap only for unbounded patterns", () => {
  // Ribotas šablonas: literalus katalogo prefiksas + wildcard tik paskutiniame segmente su
  // fiksuotu plėtiniu. Aprėptis apskaičiuojama, tad įrodymo spragos nėra — bet rūšis lieka `glob`,
  // nes sankirtos semantika (`scopesConflict`) nekeičiama.
  const bounded = ["src/tests/a-*.test.ts", "src/tests/*.ts", "src/a.*.ts", "src/tests/a-*.test.TS", "vq/generated/*.json"];
  for (const scope of bounded) {
    const writeSet = computeTaskWriteSet({ task_id: "0100", allowed_paths: [scope] });
    assert.deepEqual(writeSet.gaps, [], `bounded glob '${scope}' must not raise an evidence gap`);
    assert.equal(writeSet.determinate, true, `bounded glob '${scope}' is a determinate write set`);
    assert.equal(writeSet.entries[0]?.kind, "glob", `bounded glob '${scope}' keeps its glob kind`);
    assert.equal(writeSet.entries[0]?.scope, scope, `bounded glob '${scope}' keeps its scope value`);
  }

  const unbounded: readonly (readonly [string, string])[] = [
    ["src/a?.ts", "1: be `*` — `?` klasifikuoja kaip glob'ą, bet ribotumo neįrodo"],
    ["src/a**b.ts", "3: `**` ne segmento riboje"],
    ["**/x.ts", "3: `**` — neribotas gylis, prefiksas tuščias"],
    ["**", "3: `**` — neribotas gylis, prefiksas tuščias"],
    ["*", "4: vienas segmentas, prefiksas tuščias"],
    ["*.ts", "4: vienas segmentas — tuščias solidPrefix"],
    ["src/a-*", "6: paskutinis segmentas be fiksuoto plėtinio, ne pilnas `*`"],
    ["src/*/x.ts", "5: wildcard ne paskutiniame segmente"],
    ["src/a?-*.ts", "2: `?` lyginamas kaip raidė"],
    ["db/migrations/*.sql", "7: globali migracijų serializacija"],
  ];
  for (const [scope, brokenRule] of unbounded) {
    const writeSet = computeTaskWriteSet({ task_id: "0101", allowed_paths: [scope] });
    assert.ok(
      writeSet.gaps.some((gap) => gap.code === "wildcard-scope"),
      `unbounded glob '${scope}' keeps the wildcard-scope gap (punktas ${brokenRule})`,
    );
  }
});

test("computeTaskWriteSet: directory-form glob (`<path>/**`, `<path>/*`) resolves to a directory scope", () => {
  // Task 081: GeoGravity generatoriai rašo `modules/<m>/src/**` formos kelius. Šis šablonas turi
  // literalų, netuščią prefiksą, tad jo aprėptis YRA apibrėžta — katalogas — ir spraga nebeuždedama.
  for (const scope of ["modules/x/src/**", "src/tests/**", "src/*"]) {
    const writeSet = computeTaskWriteSet({ task_id: "0102", allowed_paths: [scope] });
    assert.deepEqual(writeSet.gaps, [], `directory-form glob '${scope}' must not raise an evidence gap`);
    assert.equal(writeSet.determinate, true, `directory-form glob '${scope}' is a determinate write set`);
    assert.equal(writeSet.entries[0]?.kind, "directory", `directory-form glob '${scope}' becomes a directory entry`);
    assert.equal(
      writeSet.entries[0]?.scope,
      scope.replace(/\/\*\*?$/, ""),
      `directory-form glob '${scope}' keeps only its literal prefix as scope`,
    );
  }

  // Plikas `**`/`*` (tuščias prefiksas) ir `**` kelio viduryje LIEKA neapibrėžti — forma neatitinka.
  for (const scope of ["**", "*", "src/**/tests"]) {
    const writeSet = computeTaskWriteSet({ task_id: "0103", allowed_paths: [scope] });
    assert.ok(writeSet.gaps.some((gap) => gap.code === "wildcard-scope"), `'${scope}' must stay unknown-scope`);
  }

  // Migracijų keliai neperklasifikuojami: globali serializacija privalo išlikti.
  const migrationGlob = computeTaskWriteSet({ task_id: "0104", allowed_paths: ["db/migrations/**"] });
  assert.ok(migrationGlob.gaps.some((gap) => gap.code === "wildcard-scope"), "migration glob keeps its evidence gap");
});

test("evaluateWriteSetIndependence: directory-form globs conflict/parallelize like real directories", () => {
  const dirVsFile = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0105", allowed_paths: ["a/src/**"] }),
    computeTaskWriteSet({ task_id: "0106", allowed_paths: ["a/src/x.ts"] }),
  );
  assert.equal(dirVsFile.independent, false, "a/src/** contains a/src/x.ts");
  assert.equal(dirVsFile.conflicts[0]?.kind, "directory");

  const dirVsDir = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0107", allowed_paths: ["a/src/**"] }),
    computeTaskWriteSet({ task_id: "0108", allowed_paths: ["b/src/**"] }),
  );
  assert.equal(dirVsDir.independent, true, "disjoint directory-form globs parallelize");

  const bareWildcard = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0109", allowed_paths: ["**"] }),
    computeTaskWriteSet({ task_id: "0110", allowed_paths: ["src/x.ts"] }),
  );
  assert.equal(bareWildcard.independent, false, "a bare ** stays unknown-scope, forcing serial execution");

  const midPathDoubleStar = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0111", allowed_paths: ["src/**/tests"] }),
    computeTaskWriteSet({ task_id: "0112", allowed_paths: ["src/x.ts"] }),
  );
  assert.equal(midPathDoubleStar.independent, false, "** in the middle of a path stays unknown-scope");
});

test("evaluateWriteSetIndependence: only clean, disjoint write sets parallelize", () => {
  const left = computeTaskWriteSet({ task_id: "0001", allowed_paths: ["src/moduleA/"] });
  const right = computeTaskWriteSet({ task_id: "0002", allowed_paths: ["src/moduleB/"] });
  const verdict = evaluateWriteSetIndependence(left, right);
  assert.equal(verdict.independent, true);
  assert.match(verdict.verdict_hash, /^iv3:[0-9a-f]{16}$/);
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

test("evaluateWriteSetIndependence: bounded globs parallelize only against proven-disjoint scopes", () => {
  const boundedGlob = computeTaskWriteSet({ task_id: "0007", allowed_paths: ["src/tests/a-*.test.ts"] });

  const disjoint = evaluateWriteSetIndependence(boundedGlob, computeTaskWriteSet({ task_id: "0008", allowed_paths: ["src/domain/x.ts"] }));
  assert.equal(disjoint.independent, true, "a bounded glob no longer costs the whole pair its parallel slot");
  assert.equal(disjoint.conflicts.length, 0);
  assert.equal(disjoint.evidence_gaps.length, 0);

  const matchingFile = evaluateWriteSetIndependence(boundedGlob, computeTaskWriteSet({ task_id: "0009", allowed_paths: ["src/tests/a-1.test.ts"] }));
  assert.equal(matchingFile.independent, false, "a file the pattern matches still conflicts");
  assert.equal(matchingFile.conflicts[0]?.kind, "glob");

  const container = evaluateWriteSetIndependence(boundedGlob, computeTaskWriteSet({ task_id: "0010", allowed_paths: ["src"] }));
  assert.equal(container.independent, false, "pathContains(kelias, solidPrefix) catches the containing directory");

  const siblingFile = evaluateWriteSetIndependence(boundedGlob, computeTaskWriteSet({ task_id: "0011", allowed_paths: ["src/tests/b.test.ts"] }));
  assert.equal(siblingFile.independent, true, "a sibling test file the pattern misses regains parallelism");

  // Du RIBOTI glob'ai su tuo pačiu kietu prefiksu (`src/tests`) nebekonfliktuoja: `scopesConflict`
  // įrodo, kad `a-*` ir `b-*` uodegos negali sutapti nė viename kelyje (task 035). Anksčiau čia
  // buvo `independent === false` su komentaru „padarius A-01, šis assert'as sąmoningai keisis".
  const twoGlobs = evaluateWriteSetIndependence(boundedGlob, computeTaskWriteSet({ task_id: "0012", allowed_paths: ["src/tests/b-*.test.ts"] }));
  assert.equal(twoGlobs.independent, true);
  assert.equal(twoGlobs.conflicts.length, 0);
  assert.equal(twoGlobs.evidence_gaps.length, 0);

  const migrationGlob = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0013", allowed_paths: ["db/migrations/*.sql"] }),
    computeTaskWriteSet({ task_id: "0014", allowed_paths: ["prisma/migrations/0002_b.sql"] }),
  );
  assert.equal(migrationGlob.independent, false, "migration globs keep their gap, so global serialization survives");

  const wildcardSymbol = evaluateWriteSetIndependence(
    computeTaskWriteSet({ task_id: "0015", allowed_paths: ["src/a/"], write_symbols: ["src/shared/*.ts"] }),
    computeTaskWriteSet({ task_id: "0016", allowed_paths: ["src/b/"], write_symbols: ["src/shared/util.ts"] }),
  );
  assert.equal(
    wildcardSymbol.independent,
    false,
    "identities compare exactly, so the wildcard gap is the only thing standing between these two",
  );
  assert.ok(wildcardSymbol.evidence_gaps.some((gap) => gap.code === "wildcard-scope"));
});
