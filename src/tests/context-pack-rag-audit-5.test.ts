// 2026-08-24 RAG auditas 5 — ką worker'is REALIAI perskaito, ir vartai, kurie egzistavo dviem
// nesutampančiomis kopijomis.
//
// Auditas 4 pasiekė, kad pack'as ĮVARDYTŲ prarastus spec ref'us. Šis auditas rado, kad tą pataisą
// anuliuoja renderis: pack'as sakydavo tiesą, o `execution-context.md` — tai, ką worker'is skaito —
// tos eilutės netekdavo pirmiau nei fragmentų, kuriuos ji aprašo.
import assert from "node:assert/strict";
import test from "node:test";
import { contextPackSchema } from "../application/context-pack/context-pack-schema.js";
import { buildCandidates } from "../application/context-pack/render-candidates.js";
import { renderExecutionContext } from "../application/context-pack/render-execution-context.js";
import { requiresFreshCodeIndex } from "../application/code-intelligence/query/guard.js";
import { requiresFreshCodeIndex as preflightRequiresFreshCodeIndex } from "../application/quality-gates/preflight.js";

function packWith(fields: Record<string, unknown>) {
  return contextPackSchema.parse({
    task_id: "0099-x",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    acceptance_criteria: ["Padaryti darbą."],
    ...fields,
  });
}

test("prarasto įrodymo įspėjimas metamas PO fragmentų, ne prieš juos", () => {
  const pack = packWith({
    spec_fragments: ["doc/spec.md\nSpec turinys."],
    spec_fragment_warnings: [
      "spec fragments dropped by the context budget: 1 (doc/other.md)",
      "spec heading not found: doc/spec.md#API (fell back to whole-file text, bounded by context budget)",
    ],
  });

  const candidates = buildCandidates(pack);
  const losses = candidates.find((candidate) => candidate.id === "spec-losses");
  const fallbacks = candidates.find((candidate) => candidate.id === "spec-warnings");
  const fragment = candidates.find((candidate) => candidate.id === "spec-1");

  assert.ok(losses && fallbacks && fragment);
  assert.equal(losses.priority, "high", "trūkstamas įrodymas yra tos pačios vertės kaip pats įrodymas");
  assert.equal(fallbacks.priority, "medium", "platesnis nei prašyta lieka žemiau — fragmentas pack'e YRA");

  // `DROP_ORDER` yra low → medium → high, o vienos pakopos viduje metama nuo GALO. Tad įspėjimas
  // apie praradimą privalo stovėti PRIEŠ fragmentus: kitaip jis iškristų pirmiau už juos.
  assert.ok(
    candidates.indexOf(losses) < candidates.indexOf(fragment),
    "praradimo eilutė canonical tvarkoje stovi prieš fragmentus, tad `high` pakopoje krenta paskutinė",
  );
});

test("ankštas biudžetas atiduoda FRAGMENTĄ pirmiau nei žinią, kad jo nebėra", () => {
  const pack = packWith({
    spec_fragments: [`doc/spec.md\n${"Ilgas spec turinys, kuris nebetelpa. ".repeat(40)}`],
    spec_fragment_warnings: ["spec fragments dropped by the context budget: 3 (a.md, b.md, c.md)"],
    out_of_scope: ["Nieko daugiau."],
  });

  const { context } = renderExecutionContext(pack, { maxChars: 1500 });
  const droppedIds = context.dropped.map((entry) => entry.id);

  assert.ok(droppedIds.includes("spec-1"), `kontrolė: fragmentas privalėjo iškristi (${droppedIds.join(", ")})`);
  assert.ok(droppedIds.includes("spec-losses"), "kontrolė: prie šio biudžeto nebetelpa nė vienas");
  assert.ok(
    droppedIds.indexOf("spec-1") < droppedIds.indexOf("spec-losses"),
    `fragmentas atiduodamas PIRMIAU už žinią apie praradimą (${droppedIds.join(", ")})`,
  );
});

test("kai telpa nors kiek, worker'is mato, kad specifikacija nepilna", () => {
  const pack = packWith({
    spec_fragments: [`doc/spec.md\n${"Ilgas spec turinys, kuris nebetelpa. ".repeat(40)}`],
    spec_fragment_warnings: ["spec fragments dropped by the context budget: 3 (a.md, b.md, c.md)"],
  });

  // Pakankamai vietos nemetamai daliai ir praradimo eilutei, bet ne 1,5 kB fragmentui.
  const { markdown, context } = renderExecutionContext(pack, { maxChars: 2000 });
  assert.ok(context.dropped.some((entry) => entry.id === "spec-1"), "kontrolė: fragmentas iškrito");
  assert.match(markdown, /Spec evidence NOT retrieved/, "o žinia apie praradimą liko");
});

// 2026-08-24: tas pats vartas buvo užrašytas DU kartus (`query/guard` ir `quality-gates/preflight`),
// ir kopijos jau buvo išsiskyrusios — preflight nepažino nei `code intelligence`, nei
// `Build code-index`, tad tas pats task'as gaudavo skirtingą atsakymą iš preflight'o ir iš dispatch
// varto.
test("code-index šviežumo vartas yra VIENA funkcija", () => {
  assert.equal(requiresFreshCodeIndex, preflightRequiresFreshCodeIndex, "dvi kopijos išsiskiria tyliai");
  assert.equal(requiresFreshCodeIndex("Naudok code intelligence analizei."), true, "kanoninė forma pažįstama abiejose");
});

test("`## Neįtraukta` paminėjimas NEIŠJUNGIA varto", () => {
  const task = [
    "# Task",
    "## Tikslas",
    "Pataisyti code graph kontekstą.",
    "## Neįtraukta",
    "- code-index build (jį daro kitas task'as)",
    "## Patikra",
    "- `pnpm test`",
  ].join("\n");

  assert.equal(
    requiresFreshCodeIndex(task),
    true,
    "NE-tikslų sekcijoje paminėta frazė reiškia, kad task'as jos NEDARO — tai ne carve-out",
  );

  // Kontrolė: task'as, kuris indeksą realiai stato, carve-out'ą vis dar gauna.
  const builder = ["# Task", "## Tikslas", "Perstatyti code-index build ir code graph context."].join("\n");
  assert.equal(requiresFreshCodeIndex(builder), false);
});
