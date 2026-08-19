// VQ-302 characterization (PAR-1): task Markdown → WorkerTaskIR runner'is prieš pažodinę
// AG_loop fixture kopiją. Task tekstai laikomi eilučių masyvais ir jungiami "\n" (CRLF/BOM
// negali patekti į source_sha256); prieš compile tvirtinama NFC normalizacija. Variantai
// išvedami iš bazės deterministinėmis replace/append operacijomis, su drift apsauga:
// kiekvienas `find` privalo egzistuoti bazėje. Record režimo NĖRA (PAR-1).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWorkerTaskIr } from "../application/context-pack/worker-task-ir.js";

type TaskTemplate = {
  lines?: string[];
  base?: string;
  replace?: Array<{ find: string; with: string }>;
  append?: string[];
};

type IrCase = { id: string; task: string; task_id: string; expect: Record<string, unknown> };

type IrFixture = {
  schema_version: number;
  record?: boolean;
  tasks: Record<string, TaskTemplate>;
  cases: IrCase[];
};

const fixturePath = path.resolve(process.cwd(), "src", "tests", "fixtures", "characterization", "worker-task-ir.json");

const fixture: IrFixture = JSON.parse(await readFile(fixturePath, "utf8"));

function taskText(name: string): string {
  const template = fixture.tasks[name];
  if (!template) throw new Error(`fixture task template missing: ${name}`);
  let lines: string[];
  if (template.lines) {
    lines = [...template.lines];
  } else {
    if (!template.base) throw new Error(`fixture task template ${name} has neither lines nor base`);
    lines = taskText(template.base).split("\n");
  }
  let text = lines.join("\n");
  for (const replacement of template.replace ?? []) {
    assert.ok(text.includes(replacement.find), `${name}: fixture drift — bazėje nėra "${replacement.find}"`);
    text = text.replace(replacement.find, replacement.with);
  }
  if (template.append && template.append.length > 0) {
    text = `${text}${template.append.join("\n")}\n`;
  }
  assert.equal(text.normalize("NFC"), text, `${name}: task tekstas privalo būti NFC`);
  return text;
}

function runCase(irCase: IrCase): unknown {
  const compiled = compileWorkerTaskIr({ taskMarkdown: taskText(irCase.task), taskId: irCase.task_id });
  if (compiled.ok) return { ok: true, ir: compiled.value };
  return { ok: false, code: (compiled.error as { code?: string }).code ?? "unknown" };
}

test("worker-task-ir characterization fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 8, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const irCase of fixture.cases) {
  test(`worker-task-ir contract: ${irCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(irCase)));
    assert.deepStrictEqual(actual, irCase.expect, irCase.id);
  });
}
