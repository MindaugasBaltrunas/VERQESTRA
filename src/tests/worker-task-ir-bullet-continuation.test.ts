// Task 030: a `## Veiksmas` / `## Neįtraukta` bullet that wraps onto a following line without
// its own marker (the standard task template does this on nearly every real task file) used to
// ALSO survive as a verbatim `raw` element, because the residue check only recognized a line as
// consumed when a captured item's own text appeared on it — a continuation line never contains
// any single item's full text. That doubled the section's content inside the IR. These tests are
// new-to-VERQESTRA behaviour, not an AG_loop parity pin (unlike `characterization-worker-task-ir`),
// so they assert on structure rather than a byte-exact recorded fixture.
import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkerTaskIr } from "../application/context-pack/worker-task-ir.js";
import { renderCompactWorkerDsl } from "../application/context-pack/compact-dsl/render.js";

function taskWithVeiksmas(veiksmas: string): string {
  return [
    "# Task",
    "",
    "## Tikslas",
    "Padengti bullet tęsinio eilutes struktūriniu parse'u.",
    "",
    "## Failai",
    "Leidžiama:",
    "- `src/application/context-pack/worker-task-ir.ts`",
    "",
    "## Veiksmas",
    veiksmas,
    "",
    "## Patikra",
    "- `pnpm test`",
    "",
    "## Stop",
    "Sustoti, kai patikra žalia.",
    "",
  ].join("\n");
}

test("multi-line bullet continuation folds into acceptance_criteria, not into a duplicate raw element", () => {
  const veiksmas = [
    "- Šis punktas turi ilgą paaiškinimą, kuris tęsiasi",
    "  antroje eilutėje be jokio bullet ženklo.",
    "- Antras, vienos eilutės punktas.",
  ].join("\n");
  const compiled = compileWorkerTaskIr({
    taskMarkdown: taskWithVeiksmas(veiksmas),
    taskId: "030-continuation-fold",
  });
  assert.ok(compiled.ok, compiled.ok ? "" : compiled.error.message);
  if (!compiled.ok) return;
  const ir = compiled.value;

  assert.deepEqual(ir.acceptance_criteria, [
    "Šis punktas turi ilgą paaiškinimą, kuris tęsiasi\nantroje eilutėje be jokio bullet ženklo.",
    "Antras, vienos eilutės punktas.",
  ]);
  assert.ok(
    !ir.elements.some((element) => element.heading === "## Veiksmas"),
    "the continuation line is now inside acceptance_criteria — ## Veiksmas must not also appear as a raw element",
  );

  // Lossless round trip: renderCompactWorkerDsl throws unless the document decodes back into
  // this exact IR, so reaching the assertion below already proves the multi-line item survives.
  const dsl = renderCompactWorkerDsl(ir);
  assert.ok(dsl.text.includes(ir.acceptance_criteria[0] ?? ""), "multi-line acceptance criterion must survive the DSL block form");
});

test("a genuinely unrelated trailing paragraph (no bullet above it) still survives as a verbatim raw element", () => {
  const veiksmas = [
    "- Pirmas punktas.",
    "- Antras punktas.",
    "",
    "Ši pastraipa nėra jokio punkto tęsinys — prieš ją yra tuščia eilutė, ne bullet.",
  ].join("\n");
  const compiled = compileWorkerTaskIr({
    taskMarkdown: taskWithVeiksmas(veiksmas),
    taskId: "030-unrelated-tail",
  });
  assert.ok(compiled.ok, compiled.ok ? "" : compiled.error.message);
  if (!compiled.ok) return;
  const ir = compiled.value;

  assert.deepEqual(ir.acceptance_criteria, ["Pirmas punktas.", "Antras punktas."]);
  const veiksmasElement = ir.elements.find((element) => element.heading === "## Veiksmas");
  assert.ok(veiksmasElement, "NO SILENT LOSS: the unrelated paragraph must keep the whole section as a raw element");
  assert.ok(
    veiksmasElement?.body.includes("Ši pastraipa nėra jokio punkto tęsinys"),
    "the raw element must still carry the unrelated paragraph verbatim",
  );
});
