// VQ-201 characterization (PAR-1): fixture — pažodinė AG_loop kopija; nesutapimas reiškia,
// kad VERQESTRA pakeitė užšaldytą elgesį. Record režimo čia NĖRA ir negali būti.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { enumerateTaskSections, normalizeTaskHeading, taskBulletItems } from "../domain/tasks/sections.js";

type SectionsCase = {
  id: string;
  kind: "sections" | "normalize" | "bullets";
  lines?: string[];
  headings?: string[];
  body?: string;
  expect: Record<string, unknown>;
};

const fixturePath = path.resolve(process.cwd(), "src", "tests", "fixtures", "characterization", "task-sections.json");
const fixture: { schema_version: number; cases: SectionsCase[] } = JSON.parse(await readFile(fixturePath, "utf8"));

function runCase(sectionsCase: SectionsCase): unknown {
  switch (sectionsCase.kind) {
    case "sections":
      return { sections: enumerateTaskSections((sectionsCase.lines ?? []).join("\n")) };
    case "normalize":
      return { normalized: (sectionsCase.headings ?? []).map((heading) => normalizeTaskHeading(heading)) };
    case "bullets":
      return { items: taskBulletItems(sectionsCase.body ?? "") };
    default:
      throw new Error(`fixture names unknown kind: ${String(sectionsCase.kind)}`);
  }
}

test("task-sections fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 6, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const sectionsCase of fixture.cases) {
  test(`task sections contract: ${sectionsCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(sectionsCase)));
    assert.deepStrictEqual(actual, sectionsCase.expect, sectionsCase.id);
  });
}
