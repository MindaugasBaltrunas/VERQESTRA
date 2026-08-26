import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWorkerTaskIr, workerTaskIrChars } from "../application/context-pack/worker-task-ir.js";
import type { WorkerTaskIr } from "../application/context-pack/worker-task-ir-schema.js";

const CORPUS_DIRS = ["AG/tasks/queue", "AG/tasks/done"];

function contentPieces(ir: WorkerTaskIr): string[] {
  return [
    ir.goal,
    ...ir.allowed_paths,
    ...ir.forbidden_paths,
    ...ir.acceptance_criteria,
    ...ir.checks,
    ir.stop,
    ...ir.spec_refs,
    ...ir.out_of_scope,
    ...ir.elements.flatMap((element) => [element.heading, element.body]),
    ...ir.omitted_sections,
  ].filter(Boolean);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

test("tmp diagnostic: content chars", async () => {
  const files: string[] = [];
  for (const dir of CORPUS_DIRS) files.push(...(await listMarkdownFiles(path.resolve(process.cwd(), dir))));

  let rawTotal = 0;
  let jsonTotal = 0;
  let contentTotal = 0;
  let n = 0;
  const rows: Array<{ id: string; raw: number; content: number; ratio: number }> = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const compiled = compileWorkerTaskIr({ taskMarkdown: raw, taskId: path.basename(file, ".md") });
    if (!compiled.ok) continue;
    n += 1;
    rawTotal += raw.length;
    jsonTotal += workerTaskIrChars(compiled.value);
    const content = contentPieces(compiled.value).join("\n").length;
    contentTotal += content;
    rows.push({ id: path.basename(file, ".md"), raw: raw.length, content, ratio: content / raw.length });
  }
  console.log(
    `files=${n} rawAvg=${(rawTotal / n).toFixed(1)} jsonAvg=${(jsonTotal / n).toFixed(1)} contentAvg=${(contentTotal / n).toFixed(1)} contentRatio=${(contentTotal / rawTotal).toFixed(4)}`,
  );
  rows.sort((a, b) => b.ratio - a.ratio);
  console.log("--- highest 8 ---");
  for (const row of rows.slice(0, 8)) console.log(`${row.ratio.toFixed(3)} ${row.id} raw=${row.raw} content=${row.content}`);
});
