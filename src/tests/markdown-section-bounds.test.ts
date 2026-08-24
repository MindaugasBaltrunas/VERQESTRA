// 2026-08-24 RAG auditas 5 — VIENA sekcijos ribos taisyklė visiems skaitytojams.
//
// `domain/tasks/sections` antraštė nuo pat pradžių sakė „never re-derive that rule elsewhere", o
// tas pats `findIndex(heading)` + `/^#{1,6}\s/` ciklas buvo užrašytas septyniuose failuose. Kai
// auditas 4 padarė `extractSection` fence-aware, likusios kopijos liko aklos — kiekviena tyliai
// savo būdu. Šis failas tikrina INVARIANTĄ per visus gyvus kelius, o ne po vieną pataisymą.
import assert from "node:assert/strict";
import test from "node:test";
import { extractSection, findSectionBounds, splitLines } from "../shared/markdown.js";
import { enumerateTaskSections } from "../domain/tasks/sections.js";
import { normalizeLegacyTaskSections, parseBacktickChecks } from "../application/quality-gates/preflight-rules.js";
import { appendSpecSourceRef } from "../interfaces/cli/dispatch/claude-preflight/spec-source.js";
import { compileWorkerTaskIr } from "../application/context-pack/worker-task-ir.js";

/** Užduotis, kurios kiekviena sekcija turi fenced bloką su `#` eilute — kasdienė forma. */
const FENCED_TASK = [
  "# Task",
  "",
  "## Tikslas",
  "Pataisyti build'ą.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/a.ts`",
  "",
  "## Veiksmas",
  "- Pirmas punktas.",
  "",
  "```bash",
  "# build",
  "pnpm build",
  "```",
  "",
  "- Antras punktas.",
  "",
  "## Patikra",
  "```text",
  "## Patikra",
  "- `pavyzdinė komanda`",
  "```",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai žalia.",
].join("\n");

test("findSectionBounds: fence nei pradeda, nei baigia sekcijos", () => {
  const lines = splitLines(FENCED_TASK);
  const bounds = findSectionBounds(lines, (line) => line.trim() === "## Veiksmas");
  assert.ok(bounds);
  assert.equal(lines[bounds.start], "## Veiksmas");
  assert.equal(lines[bounds.end], "## Patikra", "riba yra TIKROJI kita antraštė");
  assert.ok(
    lines.slice(bounds.start, bounds.end).includes("- Antras punktas."),
    "po fenced bloko einantis punktas privalo likti sekcijoje",
  );
});

test("findSectionBounds: nesamai antraštei — undefined", () => {
  assert.equal(findSectionBounds(splitLines(FENCED_TASK), (line) => line.trim() === "## Nėra"), undefined);
});

test("extractSection ir enumerateTaskSections mato TĄ PAČIĄ ribą", () => {
  const sections = enumerateTaskSections(FENCED_TASK);
  for (const section of sections) {
    if (!section.heading) continue;
    assert.equal(
      section.body,
      extractSection(FENCED_TASK, section.heading),
      `dvi ribos išsiskyrė ties ${section.heading}`,
    );
  }
});

test("cituojama antraštė NEDUODA dublikato, tad IR kompiliacija nebekrenta", () => {
  const headings = enumerateTaskSections(FENCED_TASK).map((section) => section.heading).filter(Boolean);
  assert.equal(new Set(headings).size, headings.length, `fantominis dublikatas: ${headings.join(", ")}`);

  const compiled = compileWorkerTaskIr({ taskMarkdown: FENCED_TASK, taskId: "0099-fenced" });
  assert.equal(compiled.ok, true, compiled.ok ? "" : `duplicate_section neturi atsirasti: ${compiled.error.message}`);
});

test("po fenced bloko einanti patikra vis dar backtick'uojama", () => {
  const task = [
    "# Task",
    "## Patikra",
    "```bash",
    "# pavyzdys",
    "```",
    "- pnpm test",
  ].join("\n");

  assert.deepEqual(
    parseBacktickChecks(normalizeLegacyTaskSections(task)),
    ["pnpm test"],
    "aklas ciklas nutraukdavo backtick'avimą ties fenced `#`, ir komanda preflight'ui tapdavo nematoma",
  );
});

test("naujas spec ref'as NEPATENKA į fenced bloko vidų", () => {
  const task = [
    "# Task",
    "## Spec source",
    "```text",
    "## Spec source",
    "pavyzdys.md",
    "```",
    "tikras.md",
    "",
    "## Tikslas",
    "X.",
  ].join("\n");

  const updated = appendSpecSourceRef(task, "naujas.md");
  const lines = splitLines(updated);
  const inserted = lines.indexOf("naujas.md");
  assert.ok(inserted > lines.indexOf("tikras.md"), "ref'as dedamas TIKROSIOS sekcijos gale");
  assert.ok(inserted < lines.indexOf("## Tikslas"), "ir vis dar prieš kitą antraštę");

  // Ir svarbiausia: retrieval jį realiai mato.
  assert.ok(
    extractSection(updated, "## Spec source").includes("naujas.md"),
    "ref'as fenced bloke būtų tyliai ignoruotas šaltinis",
  );
});
