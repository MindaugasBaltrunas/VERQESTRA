// Task 030: the WorkerTaskIR must not carry a task's content twice. Audited 2026-08-26 over 53
// real task files, the IR carried ~9% more content than the raw task, because a recognized
// section whose structured parse missed a line (a bullet's wrapped continuation) also kept its
// whole body verbatim. This test measures the SAME corpus shape — every real, compilable `.md`
// file under `AG/tasks/queue` and `AG/tasks/done` — and fails closed if that regresses, instead
// of trusting a one-time audit claim.
//
// The measure is `workerTaskIrContentChars`, not `workerTaskIrChars`. The latter counts the JSON
// envelope too — field names, quoting, `\n` escapes, plus `source_sha256`/`version`/`task_id`,
// none of which exist in the Markdown. That envelope is ~200 chars per task, so a perfectly
// lossless IR still JSON-encodes ~9% larger than its source. Asserting on it would mean this
// test can never distinguish "a section is duplicated" from "JSON has punctuation" — the exact
// signal it exists to catch. The envelope figure is still reported in the failure message,
// because a blown-up transport size is worth seeing even when it is not duplication.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  compileWorkerTaskIr,
  workerTaskIrChars,
  workerTaskIrContentChars,
} from "../application/context-pack/worker-task-ir.js";

const CORPUS_DIRS = ["AG/tasks/queue", "AG/tasks/done"];
// Ratio, not a hard "IR < raw" rule: a task whose `## Failai` genuinely mixes path bullets with
// prose ("- visi kiti failai", an inline blockquote) still pays the NO SILENT LOSS verbatim cost,
// on purpose. The corpus average must stay close to 1.0, not every single file.
// Measured 2026-08-26 over 57 files: raw avg 2277.2, IR content avg 2043.6 → ratio 0.897, and no
// single file exceeded 1.000. The 1.02 ceiling therefore has real headroom above the fix, and a
// regression that re-duplicates one section moves it well past the limit.
const MAX_IR_TO_RAW_RATIO = 1.02;

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

test("worker-task-ir corpus: IR average does not carry real task content twice", async () => {
  const files: string[] = [];
  for (const dir of CORPUS_DIRS) {
    files.push(...(await listMarkdownFiles(path.resolve(process.cwd(), dir))));
  }

  let rawTotal = 0;
  let contentTotal = 0;
  let jsonTotal = 0;
  let compiledCount = 0;
  const skipped: string[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const taskId = path.basename(file, ".md");
    const compiled = compileWorkerTaskIr({ taskMarkdown: raw, taskId });
    if (!compiled.ok) {
      skipped.push(`${taskId} (${compiled.error.code})`);
      continue;
    }
    rawTotal += raw.length;
    contentTotal += workerTaskIrContentChars(compiled.value);
    jsonTotal += workerTaskIrChars(compiled.value);
    compiledCount += 1;
  }

  assert.ok(
    compiledCount > 0,
    `no compilable task files found under ${CORPUS_DIRS.join(", ")} — corpus measurement has nothing to measure ` +
      `(${skipped.length} file(s) failed to compile: ${skipped.join(", ")})`,
  );

  const rawAvg = rawTotal / compiledCount;
  const contentAvg = contentTotal / compiledCount;
  const jsonAvg = jsonTotal / compiledCount;
  const ratio = contentAvg / rawAvg;

  assert.ok(
    ratio < MAX_IR_TO_RAW_RATIO || contentAvg < rawAvg,
    `IR content average ${contentAvg.toFixed(1)} chars vs raw average ${rawAvg.toFixed(1)} chars over ` +
      `${compiledCount} task file(s) is a ${((ratio - 1) * 100).toFixed(1)}% duplication ` +
      `(limit ${((MAX_IR_TO_RAW_RATIO - 1) * 100).toFixed(0)}%) — a structured section is keeping a verbatim ` +
      `copy of content it should now cover. JSON-encoded average for reference: ${jsonAvg.toFixed(1)} chars.`,
  );
});

// A green ratio only means something if the metric can go red. This pins the sensitivity: put the
// regression back — a `## Veiksmas` already folded into `acceptance_criteria` kept verbatim in
// `elements` as well — and the same measure must cross the same 1.02 ceiling.
test("workerTaskIrContentChars detects the duplication it guards against", () => {
  const veiksmasBody = [
    "- Šis punktas turi ilgą paaiškinimą, kuris tęsiasi",
    "  antroje eilutėje be jokio bullet ženklo.",
    "- Antras, vienos eilutės punktas.",
  ].join("\n");
  const taskMarkdown = [
    "# Task",
    "",
    "## Tikslas",
    "Įrodyti, kad dubliavimo matas tikrai dega.",
    "",
    "## Failai",
    "Leidžiama:",
    "- `src/application/context-pack/worker-task-ir.ts`",
    "",
    "## Veiksmas",
    veiksmasBody,
    "",
    "## Patikra",
    "- `pnpm test`",
    "",
    "## Stop",
    "Sustoti, kai patikra žalia.",
    "",
  ].join("\n");

  const compiled = compileWorkerTaskIr({ taskMarkdown, taskId: "030-duplication-sensitivity" });
  assert.ok(compiled.ok, compiled.ok ? "" : compiled.error.message);
  if (!compiled.ok) return;

  const clean = workerTaskIrContentChars(compiled.value);
  assert.ok(
    clean / taskMarkdown.length < MAX_IR_TO_RAW_RATIO,
    `the non-duplicating IR must sit under the ceiling (got ${(clean / taskMarkdown.length).toFixed(3)})`,
  );

  const duplicated = workerTaskIrContentChars({
    ...compiled.value,
    elements: [...compiled.value.elements, { heading: "## Veiksmas", kind: "raw", body: veiksmasBody }],
  });
  assert.ok(
    duplicated / taskMarkdown.length >= MAX_IR_TO_RAW_RATIO,
    `re-duplicating ## Veiksmas must break the ceiling, otherwise the corpus assertion is decorative ` +
      `(clean ${clean}, duplicated ${duplicated}, raw ${taskMarkdown.length})`,
  );
});
