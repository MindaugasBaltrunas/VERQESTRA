// 144-a: RAG auditas 7, radinys R2 (P3) — `spec_dropped_count` PERDĖJO praradimus.
//
// `runSpecPhase` sumuodavo `duplicate` numetimus į `droppedCount`, nors lauko dokumentacija
// (`SpecPhaseResult.droppedCount`) sako „PRARASTŲ ref'ų skaičius" — o task'o autoriaus PATS
// pakartotas ref'as nėra praradimas: turinys pack'e yra, tik per pirmąjį paminėjimą. Metrika
// dabar skaičiuoja `unresolved + dropped BE duplicate`; `duplicate` įspėjimas pačiame
// `spec_fragment_warnings` sąraše lieka nepakitęs.
import assert from "node:assert/strict";
import test from "node:test";
import { runSpecPhase } from "../application/context-pack/assemble/spec-phase.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import type { ParsedContextPackTask } from "../application/context-pack/assemble/parse-task.js";

function baseParsedTask(specSources: string[]): ParsedContextPackTask {
  return {
    goal: "tikslas",
    allowedPaths: [],
    specSources,
    checks: [],
    outOfScope: [],
    acceptanceCriteria: [],
    stopCondition: "",
  };
}

test("duplicate numetimas NEPADIDINA droppedCount, bet lieka įspėjime", async () => {
  const fs: CodeIntelligenceFileSystemPort = {
    listDirectory: () => Promise.resolve([]),
    statKind: (absolutePath) =>
      Promise.resolve(absolutePath.includes("missing.md") ? "absent" : "file"),
    readTextFile: () => Promise.resolve("SAME CONTENT, DVIEJŲ REF'Ų"),
    readFileBytes: () => Promise.resolve(new Uint8Array()),
    fileSize: () => Promise.resolve(0),
    exists: () => Promise.resolve(true),
    writeTextFileAtomic: () => Promise.resolve(),
    makeDirectory: () => Promise.resolve(),
  };

  const result = await runSpecPhase({
    codeFs: fs,
    projectRoot: "/repo",
    parsedTask: baseParsedTask(["dup-a.md", "dup-b.md", "missing.md"]),
    specCharBudget: 10_000,
    maxSpecFragments: 10,
  });

  assert.deepEqual(result.kept.map((entry) => entry.ref), ["dup-a.md"], "antras ref'as — dublikatas turinio, ne rašto");
  assert.equal(
    result.droppedCount,
    1,
    "vienintelis TIKRAS praradimas yra missing.md; dup-b.md turinys pack'e liko per dup-a.md",
  );
  assert.ok(
    result.warnings.some((warning) => warning.text.includes("duplicate reference in the task")),
    "dublikato įspėjimas privalo likti matomas, net kai jis nebekrenta į metriką",
  );
  assert.ok(
    result.warnings.some((warning) => warning.text === "spec source not found: missing.md"),
    "tikras praradimas privalo likti įspėjime",
  );
});

test("unresolved ir char_budget numetimai vis dar skaičiuojami droppedCount", async () => {
  const contentByPath = new Map([
    ["big-a.md", "A".repeat(30)],
    ["big-b.md", "B".repeat(30)],
  ]);
  const fs: CodeIntelligenceFileSystemPort = {
    listDirectory: () => Promise.resolve([]),
    statKind: () => Promise.resolve("file"),
    readTextFile: (absolutePath) => {
      const entry = [...contentByPath.entries()].find(([name]) => absolutePath.includes(name));
      if (!entry) {
        throw new Error(`unexpected path in test double: ${absolutePath}`);
      }
      return Promise.resolve(entry[1]);
    },
    readFileBytes: () => Promise.resolve(new Uint8Array()),
    fileSize: () => Promise.resolve(0),
    exists: () => Promise.resolve(true),
    writeTextFileAtomic: () => Promise.resolve(),
    makeDirectory: () => Promise.resolve(),
  };

  // 20 simbolių biudžetas: `big-a.md` (20 po kirpimo) suvalgo visą biudžetą, `big-b.md` neturi
  // kur tilpti — tai `char_budget` numetimas, o ne `duplicate`, ir jis PRIVALO likti metrikoje.
  const result = await runSpecPhase({
    codeFs: fs,
    projectRoot: "/repo",
    parsedTask: baseParsedTask(["big-a.md", "big-b.md"]),
    specCharBudget: 20,
    maxSpecFragments: 10,
  });

  assert.deepEqual(result.kept.map((entry) => entry.ref), ["big-a.md"]);
  assert.equal(result.droppedCount, 1, "char_budget numetimas yra TIKRAS praradimas ir turi likti skaičiuojamas");
  assert.ok(
    result.warnings.some((warning) => warning.text.includes("context char budget exhausted")),
    "priežastis turi likti matoma įspėjime",
  );
});
