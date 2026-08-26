// Task 035: `scopesConflict` glob/glob įrodomo nepersidengimo šaka. Du glob'ai su tuo pačiu
// kietu prefiksu, kurių uodegos negali sutapti nė viename kelyje, nebeatima vienas kito
// lygiagretumo — o ko įrodyti nepavyksta, lieka sankirta (fail-closed nesilpninamas).
//
// Paskutinis testas šiame faile yra VARTAS: jis mechaniškai tikrina, kad kiekvienas `false`
// verdiktas atitinka TIKRĄ tuščią aprėpčių sankirtą pagal `scopeCovers`.
import assert from "node:assert/strict";
import test from "node:test";
import { scopeCovers, scopesConflict } from "../domain/scheduling/scope-lock-rules.js";

const g = (scope: string) => ({ kind: "glob" as const, scope });
const f = (scope: string) => ({ kind: "file" as const, scope });
const d = (scope: string) => ({ kind: "directory" as const, scope });

test("scopesConflict: proven-disjoint glob tails under an equal solid prefix are not a conflict", () => {
  const disjoint: readonly (readonly [string, string, string])[] = [
    ["src/tests/a-*.test.ts", "src/tests/b-*.test.ts", "skirtingi literalūs prefiksai iki pirmos žvaigždutės"],
    ["src/TESTS/A-*.test.ts", "src/tests/b-*.test.ts", "kietų prefiksų lygybė yra be registro, kaip ir globMatches"],
    ["src/tests/*-a.test.ts", "src/tests/*-b.test.ts", "skirtingi literalūs sufiksai po paskutinės žvaigždutės"],
    ["src/*", "src/*/*", "skirtingas uodegos segmentų skaičius"],
    ["src/tests/*.ts", "src/tests/*/x.ts", "skirtingas uodegos segmentų skaičius gilesnėje uodegoje"],
    ["src/*/a.ts", "src/*/b.ts", "pirmas segmentas sutampa, antras — skirtingi literalai"],
    ["src/*/foo.ts", "src/*/bar*.ts", "literalas prieš šabloną: `foo.ts` neatitinka `bar*.ts`"],
    ["src/**", "docs/**", "nepersidengiantys kieti prefiksai — elgesys nepakitęs"],
  ];

  for (const [left, right, why] of disjoint) {
    assert.equal(scopesConflict(g(left), g(right)), false, `'${left}' vs '${right}': ${why}`);
    assert.equal(scopesConflict(g(right), g(left)), false, `simetrija: '${right}' vs '${left}': ${why}`);
  }
});

test("scopesConflict: everything short of a proof stays a conflict", () => {
  const conflicting: readonly (readonly [string, string, string])[] = [
    [
      "src/a?.ts",
      "src/*/y.log",
      "`?` be nė vienos žvaigždutės reiškia KATALOGĄ, tad uodegos ilgis nieko neįrodo",
    ],
    ["src/tests/a**b.ts", "src/tests/c-*.ts", "dviguba žvaigždutė kerta pasvirąjį brūkšnį — segmentų skaičius meluotų"],
    ["src/*/foo.ts", "src/*/f*.ts", "`foo.ts` atitinka `f*.ts` — sankirta netuščia"],
    ["src/tests/a*.ts", "src/tests/*b.ts", "`ab.ts` atitinka abu"],
    ["src/tests/a*.ts", "src/tests/ab*.ts", "prefiksai palyginami, sufiksai sutampa"],
    ["src/*.ts", "src/tests/*.ts", "sąmoningas nepilnumas: kieti prefiksai NELYGŪS, tad įrodymas net nebandomas"],
    [
      "src/tests/*.ts",
      "src/tests/nested/*.ts",
      "tas pats nepilnumas gilesniu lygiu: `src/tests` != `src/tests/nested`, nors uodegos ir nesikirstų",
    ],
    ["src/tests", "src/tests/a-*.test.ts", "be-žvaigždutės šablonas yra katalogas ir dengia visą uodegą"],
    ["src/**", "src/*", "characterization invariantas scc-glob-nested"],
    ["**/index.ts", "src/**", "characterization invariantas scc-glob-empty-prefix-fail-closed: tuščias kietas prefiksas"],
    ["src/tests/**", "src/tests/b-*.test.ts", "neribotas gylis niekada neįrodo nepersidengimo"],
  ];

  for (const [left, right, why] of conflicting) {
    assert.equal(scopesConflict(g(left), g(right)), true, `'${left}' vs '${right}': ${why}`);
    assert.equal(scopesConflict(g(right), g(left)), true, `simetrija: '${right}' vs '${left}': ${why}`);
  }
});

test("scopesConflict: the `?` bail-out closes a real overlapping path", () => {
  // Konkretus kelias, kurį dengia ABU šablonai, nors jų uodegų ilgiai skiriasi (1 vs 2).
  // Būtent dėl jo `globTailSegments` grąžina `null`, kai segmente yra `?`.
  const overlapping = "src/a?.ts/y.log";
  assert.ok(scopeCovers(g("src/a?.ts"), overlapping), "be-žvaigždutės šablonas dengia savo pakatalogį");
  assert.ok(scopeCovers(g("src/*/y.log"), overlapping), "vieno lygio žvaigždutė dengia `a?.ts` segmentą");
  assert.equal(scopesConflict(g("src/a?.ts"), g("src/*/y.log")), true);
});

test("scopesConflict: non-glob kinds keep their previous verdicts", () => {
  assert.equal(scopesConflict(g("src/tests/a-*.test.ts"), f("src/tests/a-1.test.ts")), true, "šabloną atitinkantis failas");
  assert.equal(scopesConflict(g("src/tests/a-*.test.ts"), f("src/tests/b.test.ts")), false, "šablono nepataikantis kaimynas");
  assert.equal(scopesConflict(g("src/tests/a-*.test.ts"), d("src")), true, "kietą prefiksą apimantis katalogas");
  assert.equal(scopesConflict(f("src/tests/a-1.test.ts"), g("src/tests/a-*.test.ts")), true, "simetrija");
  assert.equal(scopesConflict(f("src/tests/b.test.ts"), g("src/tests/a-*.test.ts")), false, "simetrija");
  assert.equal(scopesConflict(d("src"), g("src/tests/a-*.test.ts")), true, "simetrija");
});

/** Fiksuotas šablonų korpusas — jokio atsitiktinumo, kad kritęs vartas būtų atkuriamas. */
const PATTERNS: readonly string[] = [
  "src/tests/a-*.test.ts",
  "src/tests/b-*.test.ts",
  "src/TESTS/A-*.test.ts",
  "src/tests/*-a.test.ts",
  "src/tests/*-b.test.ts",
  "src/tests/*.ts",
  "src/tests/nested/*.ts",
  "src/tests/a*.ts",
  "src/tests/*b.ts",
  "src/tests/ab*.ts",
  "src/tests/c-*.ts",
  "src/tests/a**b.ts",
  "src/tests/*",
  "src/tests/*/x.ts",
  "src/tests/**",
  "src/tests",
  "src/*",
  "src/*/*",
  "src/*.ts",
  "src/*/a.ts",
  "src/*/b.ts",
  "src/*/foo.ts",
  "src/*/bar*.ts",
  "src/*/f*.ts",
  "src/*/y.log",
  "src/a?.ts",
  "src/a**b.ts",
  "src/**",
  "docs/**",
  "db/migrations/*.sql",
  "**/index.ts",
];

const SEGMENTS: readonly string[] = [
  "src",
  "docs",
  "tests",
  "nested",
  "a-1.test.ts",
  "b-1.test.ts",
  "ab.ts",
  "foo.ts",
  "y.log",
  "a?.ts",
  "index.ts",
];

/** Ciklinis segmento parinkimas: `noUncheckedIndexedAccess` neleidžia žalio indekso. */
function segment(index: number): string {
  return SEGMENTS[index % SEGMENTS.length] ?? "src";
}

/**
 * Kelių korpusas: visi 1 ir 2 gylio deriniai plius deterministiškai išretinti 3 ir 4 gylio
 * keliai. Rankiniai papildymai fiksuoja tas kombinacijas, kurios yra atskirų taisyklių
 * kontrpavyzdžiai — jos privalo būti korpuse net jei retinimas jų nepagautų.
 */
function buildPathCorpus(): string[] {
  const paths = new Set<string>();
  for (let i = 0; i < SEGMENTS.length; i += 1) {
    paths.add(segment(i));
    for (let j = 0; j < SEGMENTS.length; j += 1) paths.add(`${segment(i)}/${segment(j)}`);
    paths.add(`${segment(i)}/${segment(i + 3)}/${segment(i + 7)}`);
    paths.add(`${segment(i)}/${segment(i + 5)}/${segment(i + 2)}/${segment(i + 9)}`);
  }
  for (const extra of [
    "src/a?.ts/y.log",
    "src/tests/a-1.test.ts",
    "src/tests/b-1.test.ts",
    "src/tests/ab.ts",
    "src/tests/foo.ts",
    "src/tests/index.ts",
    "src/tests/y.log",
    "src/tests/nested/ab.ts",
    "src/tests/nested/x.ts",
    "src/tests/nested/index.ts",
    "src/nested/y.log",
    "src/nested/a.ts",
    "src/nested/b.ts",
    "src/nested/foo.ts",
    "src/nested/bar.ts",
    "src/index.ts",
    "docs/index.ts",
    "db/migrations/0001_init.sql",
  ]) {
    paths.add(extra);
  }
  return [...paths];
}

test("scopesConflict: soundness oracle — a `false` verdict never hides a shared path", () => {
  const paths = buildPathCorpus();
  assert.ok(paths.length >= 40, `kelių korpusas per mažas: ${paths.length}`);
  assert.ok(paths.includes("src/a?.ts/y.log"), "kontrpavyzdinis kelias privalo būti korpuse");
  assert.ok(PATTERNS.length >= 20, `šablonų korpusas per mažas: ${PATTERNS.length}`);

  let provenDisjointPairs = 0;
  for (const [leftIndex, left] of PATTERNS.entries()) {
    for (const right of PATTERNS.slice(leftIndex)) {
      const verdict = scopesConflict(g(left), g(right));
      assert.equal(verdict, scopesConflict(g(right), g(left)), `nesimetriška pora: '${left}' vs '${right}'`);
      if (verdict) continue;
      provenDisjointPairs += 1;
      for (const path of paths) {
        assert.ok(
          !(scopeCovers(g(left), path) && scopeCovers(g(right), path)),
          `NESOUND: '${path}' atitinka ir '${left}', ir '${right}', bet scopesConflict grąžino false`,
        );
      }
    }
  }

  assert.ok(provenDisjointPairs > 0, "vartas be nė vienos `false` poros nieko netikrintų");
});
