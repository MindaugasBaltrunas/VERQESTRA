// Task 031: both compiled worker prompt bodies open with a fixed preamble + fence. Audited
// 2026-08-26: that fixed cost averaged ~586 chars (IR) — ~27% of a small task's whole raw
// size — because the reading key restated `task_id`/`source_sha256` in prose even though the
// document one line below already carries both as fields. This test measures the SAME fixed
// cost (`compiledChars - document.length`) over the real corpus and fails closed if either
// renderer's preamble regresses past the ceiling `worker-prompt-compilation.ts` was rewritten
// to hit.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWorkerTaskIr, workerTaskIrChars } from "../application/context-pack/worker-task-ir.js";
import { renderCompactWorkerDsl } from "../application/context-pack/compact-dsl/render.js";
import { compileWorkerPromptTask } from "../application/context-pack/worker-prompt-compilation.js";
import { parseContextCompressionConfig } from "../domain/policies/compression/features.js";

const CORPUS_DIRS = ["AG/tasks/queue", "AG/tasks/done"];
// AC1 (task 031 spec): fixed preamble+fence cost per task, both renderers, real corpus.
const MAX_PREAMBLE_ADDED_CHARS = 250;

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

test("compiled worker prompt preamble: fixed added cost stays <=250 chars per task, both modes", async () => {
  const files: string[] = [];
  for (const dir of CORPUS_DIRS) {
    files.push(...(await listMarkdownFiles(path.resolve(process.cwd(), dir))));
  }

  const irConfig = parseContextCompressionConfig({ version: 1, features: { worker_task_ir: true } });
  const dslConfig = parseContextCompressionConfig({
    version: 1,
    features: { worker_task_ir: true, compact_dsl: true },
  });

  let measured = 0;
  const overBudget: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const taskId = path.basename(file, ".md");
    const compiled = compileWorkerTaskIr({ taskMarkdown: raw, taskId });
    if (!compiled.ok) {
      skipped.push(`${taskId} (${compiled.error.code})`);
      continue;
    }
    const ir = compiled.value;
    measured += 1;

    const irCompiled = compileWorkerPromptTask({ config: irConfig, taskId, taskText: raw });
    if (irCompiled.kind === "compiled") {
      const added = irCompiled.task.compiledChars - workerTaskIrChars(ir);
      if (added > MAX_PREAMBLE_ADDED_CHARS) overBudget.push(`${taskId} worker_task_ir +${added}`);
    } else {
      skipped.push(`${taskId} (worker_task_ir did not compile)`);
    }

    const dslCompiled = compileWorkerPromptTask({ config: dslConfig, taskId, taskText: raw });
    if (dslCompiled.kind === "compiled") {
      const dsl = renderCompactWorkerDsl(ir);
      const documentChars = dsl.text.endsWith("\n") ? dsl.text.length - 1 : dsl.text.length;
      const added = dslCompiled.task.compiledChars - documentChars;
      if (added > MAX_PREAMBLE_ADDED_CHARS) overBudget.push(`${taskId} compact_dsl +${added}`);
    } else {
      skipped.push(`${taskId} (compact_dsl did not compile)`);
    }
  }

  assert.ok(
    measured > 0,
    `no compilable task files found under ${CORPUS_DIRS.join(", ")} — nothing measured (${skipped.join(", ")})`,
  );
  assert.deepEqual(
    overBudget,
    [],
    `preamble+fence added more than ${MAX_PREAMBLE_ADDED_CHARS} chars over ${measured} task(s): ${overBudget.join(", ")}`,
  );
});
