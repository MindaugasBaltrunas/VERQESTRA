// 070/child-1: etalonas ir sections.ts parseris privalo sutapti — jei kas nors pervadina ar
// pašalina etalono `## ` antraštę, arba parseris nustoja ją atpažinti, šis testas krinta su
// konkrečios antraštės pavadinimu žinutėje, ne su bendru "sections mismatch".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { enumerateTaskSections, normalizeTaskHeading } from "../domain/tasks/sections.js";

const ETALONAS_PATH = path.resolve(process.cwd(), "AG", "tasks", "examples", "000-etalonas.md");

// Dokumento tvarka; tik `## ` (level 2) antraštės — `# Task` yra preambulė, ne task'o sekcija.
const EXPECTED_HEADINGS = [
  "## Spec source",
  "## Priklausomybės",
  "## Žingsnis 0 — ar jau įgyvendinta?",
  "## Tikslas",
  "## Agentai",
  "## Failai",
  "## Veiksmas",
  "## Patikra",
  "## Stop",
  "## Neįtraukta",
];

async function loadEtalonas(): Promise<string> {
  return readFile(ETALONAS_PATH, "utf8");
}

test("etalono `## ` antraščių tvarka ir sąrašas sutampa su parserio rezultatu", async () => {
  const markdown = await loadEtalonas();
  const level2Sections = enumerateTaskSections(markdown).filter((section) => section.level === 2);

  const expectedKeys = EXPECTED_HEADINGS.map((heading) => normalizeTaskHeading(heading));
  const actualKeys = level2Sections.map((section) => section.key);
  const actualHeadings = level2Sections.map((section) => section.heading);

  assert.equal(
    actualKeys.length,
    expectedKeys.length,
    `etalonas turi ${actualKeys.length} '## ' sekcijas, tikėtasi ${expectedKeys.length}: ${actualHeadings.join(", ")}`,
  );

  for (const [index, expectedKey] of expectedKeys.entries()) {
    assert.equal(
      actualKeys[index],
      expectedKey,
      `etalono sekcija "${EXPECTED_HEADINGS[index] ?? ""}" parserio nebeatpažinta arba pervadinta ` +
        `(gauta antraštė: "${actualHeadings[index] ?? "<nėra>"}")`,
    );
  }
});

test("kiekviena etalono `## ` sekcija turi netuščią kūną", async () => {
  const markdown = await loadEtalonas();
  const level2Sections = enumerateTaskSections(markdown).filter((section) => section.level === 2);

  for (const section of level2Sections) {
    assert.ok(
      section.body.trim().length > 0,
      `etalono sekcija "${section.heading}" turi tuščią kūną — parseris ją praryja be turinio`,
    );
  }
});

test("parseris nepraleidžia nė vienos etalono `## ` antraštės eilutės", async () => {
  const markdown = await loadEtalonas();
  const rawHeadingLines = markdown
    .split(/\r\n|\n/)
    .filter((line) => /^##\s/.test(line))
    .map((line) => line.trim());

  const parsedHeadings = enumerateTaskSections(markdown)
    .filter((section) => section.level === 2)
    .map((section) => section.heading);

  assert.deepStrictEqual(
    parsedHeadings,
    rawHeadingLines,
    "parserio surastos '## ' antraštės nesutampa su etalono faile esančiomis eilutėmis",
  );
});
