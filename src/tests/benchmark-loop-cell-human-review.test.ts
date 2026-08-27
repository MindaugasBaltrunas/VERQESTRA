// Regresija 023: ag-loop benchmark celės, parkuotos human-review vartų prieš pirmą dispatch'ą.
//
// 2026-08-26 pilnas bėgimas (run-20260825t210704416z) grąžino 8 scenarijus × 3 pakartojimus su
// `telemetry.attempts out-of-range: received 0` — ag-loop aprėptis 16/24. Šis testas laiko abu
// šio fakto galus vietoje: kad be parašo vartai TIKRAI parkuoja (kitaip pataisymas neturėtų
// dalyko), ir kad su parašu — nebe. Vartų taisyklės čia nekeičiamos ir netikrinamos: tikrinamas
// tik įrodymo buvimas celės task'e.
//
// Scenarijai skaitomi iš `AG/benchmark/scenarios`, o ne kartojami literalu: parkavimo priežastis
// gyvena scenarijaus TEKSTE, tad kopija čia reikštų, kad testas tikrina savo pačios kopiją.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeHumanReviewGates,
  type HumanReviewGateCategory,
} from "../domain/tasks/human-review/gates.js";
import { allowedPaths } from "../domain/tasks/allowed-paths.js";
import { renderCellTask, type CellTaskInput } from "../interfaces/cli/benchmark/benchmark-cell.js";
import {
  CELL_HUMAN_REVIEW_APPROVAL,
  withCellHumanReviewApproval,
} from "../interfaces/cli/benchmark/benchmark-loop-cell.js";

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const scenarioDir = path.join(repositoryRoot, "AG", "benchmark", "scenarios");

/**
 * Domeno varto atpažįstama parašo forma (`domain/tasks/human-review/gates.ts`).
 *
 * Sąmoninga kopija: testas tikrina, kad celės parašas tenkina TĄ PAČIĄ formą, kurios reikalauja
 * vartas. Importavus patį regex'ą, testas praeitų ir tada, kai abu pasislinktų kartu.
 */
const APPROVED_MARKER_SHAPE = /^(?:[-*]\s+)?HUMAN-REVIEW-APPROVED:\s*(\S.*)$/im;

/**
 * Kiekvienas scenarijus ir vartas, kuris jį 2026-08-26 parkavo.
 *
 * Kategorija čia yra tyrimo rezultatas, ne dekoracija: 7 scenarijai kertasi su `security`, o
 * `refactor-badge-markup-builder` — su `dependency`, nes jo tekste yra sakinys „Do not add a
 * dependency", kurį varto frazė gaudo pažodžiui. Ta viena eilutė yra visas skirtumas tarp
 * „saugumo raktažodžių šablonas" ir tikrosios priežasties, tad ji pinama testu.
 */
const PARKED_SCENARIOS: readonly {
  readonly id: string;
  readonly category: HumanReviewGateCategory;
}[] = [
  { id: "bugfix-session-token-expiry", category: "security" },
  { id: "code-permission-wildcard", category: "security" },
  { id: "refactor-badge-markup-builder", category: "dependency" },
  { id: "refactor-permission-inheritance", category: "security" },
  { id: "security-log-session-tokens", category: "security" },
  { id: "security-skip-signature-check", category: "security" },
  { id: "security-unknown-role-admin", category: "security" },
  { id: "tests-permission-denial-matrix", category: "security" },
];

type ScenarioDeclaration = {
  readonly id: string;
  readonly task: string;
  readonly allowedPaths: readonly string[];
  readonly checks?: readonly { readonly command: readonly string[] }[];
};

async function readScenario(id: string): Promise<ScenarioDeclaration> {
  const file = path.join(scenarioDir, `${id}.scenario.json`);
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(parsed !== null && typeof parsed === "object", `${id}: scenario is not an object`);
  return parsed as ScenarioDeclaration;
}

function cellInput(scenario: ScenarioDeclaration): CellTaskInput {
  return {
    prompt: scenario.task,
    allowedPaths: scenario.allowedPaths,
    checks: (scenario.checks ?? []).map((check) => ({ command: check.command })),
    taskId: scenario.id,
  };
}

test("the eight scenarios the 2026-08-26 run left unmeasured are parked by a gate without the marker", async () => {
  for (const { id, category } of PARKED_SCENARIOS) {
    const scenario = await readScenario(id);
    const taskText = renderCellTask(cellInput(scenario));
    const verdict = analyzeHumanReviewGates(taskText, allowedPaths(taskText));

    assert.equal(
      verdict.requires_human_review,
      true,
      `${id}: no gate parks this cell any more, so the regression it stands for is gone ` +
        "and this scenario no longer belongs in the list",
    );
    assert.deepEqual(
      verdict.gates.map((gate) => gate.category).includes(category),
      true,
      `${id}: expected the ${category} gate; got ${verdict.gates.map((gate) => gate.category).join(", ")}`,
    );
  }
});

test("only refactor-badge-markup-builder is parked by something other than the security gate", async () => {
  // Prieš renkant sprendimą reikėjo įvardyti, kodėl šis scenarijus netelpa į saugumo šabloną.
  // Atsakymas — `dependency` vartas, ne `security` — pinamas testu, kad kita hipotezė apie „visi
  // aštuoni yra saugumo raktažodžiai" nebūtų sukurta iš naujo.
  const scenario = await readScenario("refactor-badge-markup-builder");
  const taskText = renderCellTask(cellInput(scenario));
  const categories = analyzeHumanReviewGates(taskText, allowedPaths(taskText)).gates.map(
    (gate) => gate.category,
  );

  assert.deepEqual(categories, ["dependency"]);
  assert.match(scenario.task, /add a dependency/i);
});

test("the cell's marker lifts every one of those gates without touching a gate rule", async () => {
  for (const { id } of PARKED_SCENARIOS) {
    const scenario = await readScenario(id);
    const taskText = withCellHumanReviewApproval(renderCellTask(cellInput(scenario)));
    const verdict = analyzeHumanReviewGates(taskText, allowedPaths(taskText));

    assert.equal(verdict.requires_human_review, false, `${id}: still parked with the marker on`);
    assert.deepEqual(verdict.gates, []);
    assert.equal(typeof verdict.approved_marker, "string");
    assert.match(verdict.approved_marker ?? "", /^benchmark-suite /);
  }
});

test("the marker matches the shape the gate recognises, on its own line", () => {
  assert.match(CELL_HUMAN_REVIEW_APPROVAL, APPROVED_MARKER_SHAPE);
  // Laisvo teksto viduryje žyma nesuveikia (gates.ts:44), tad ji privalo turėti savo eilutę.
  assert.equal(CELL_HUMAN_REVIEW_APPROVAL.includes("\n"), false);

  const marked = withCellHumanReviewApproval("# Task\n\n## Tikslas\nbet kas\n");
  assert.deepEqual(marked.split("\n").includes(CELL_HUMAN_REVIEW_APPROVAL), true);
  // Data yra fiksuota: judanti data reikštų naują žmogaus sprendimą kiekvienam bėgimui.
  assert.match(CELL_HUMAN_REVIEW_APPROVAL, /\b2026-08-27\b/);
});

test("the marker lands in the preamble, so the prompt in `## Tikslas` stays byte-identical", async () => {
  // BENCH-3: `agent-solo` gauna scenarijaus tekstą, ir loop'o `## Tikslas` privalo būti TAS PATS
  // tekstas. Parašas gyvena preambulėje tarp `# Task` ir pirmos sekcijos — jokia sekcija
  // nepasikeičia.
  for (const { id } of PARKED_SCENARIOS) {
    const scenario = await readScenario(id);
    const plain = renderCellTask(cellInput(scenario));
    const marked = withCellHumanReviewApproval(plain);

    const goal = /^## Tikslas\r?\n([\s\S]*?)(?=\r?\n## )/m;
    assert.equal(marked.match(goal)?.[1], plain.match(goal)?.[1]);
    // `.trim()` tik dėl sekciją skiriančios tuščios eilutės — pats promptas lyginamas pažodžiui.
    assert.equal(marked.match(goal)?.[1]?.trim(), scenario.task.trim());
    assert.equal(marked.startsWith("# Task\n"), true);
    assert.deepEqual(allowedPaths(marked), allowedPaths(plain));
  }
});

test("a task text with no `# Task` heading still gets a marker rather than losing it silently", () => {
  const marked = withCellHumanReviewApproval("## Tikslas\nbe antrastes\n");
  assert.equal(analyzeHumanReviewGates(marked).approved_marker?.startsWith("benchmark-suite"), true);
});
