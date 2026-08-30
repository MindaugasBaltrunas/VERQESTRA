// 071: struktūrinis etalono validatorius. Kiekvienai taisyklei po blokavimo ir po praėjimo
// atvejį, plius teigiamas kontrolinis atvejis — pats etalono failas privalo grąžinti tuščią
// Violation[] (jis pats yra visų sekcijų, įskaitant neprivalomas, kanoninis pavyzdys).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateTaskAgainstEtalonas } from "../domain/tasks/etalonas-rules.js";

const ETALONAS_PATH = path.resolve(process.cwd(), "AG", "tasks", "examples", "000-etalonas.md");

function loadEtalonas(): Promise<string> {
  return readFile(ETALONAS_PATH, "utf8");
}

/** Minimal task with every mandatory section, in etalon order, and nothing else. */
const VALID_TASK = `# Task

## Spec source
openspec/changes/example

## Tikslas
Problema su įrodymu.

## Agentai
readme-guard -> coder -> tester

## Failai
Leidžiama:
- \`src/domain/example.ts\`

Draudžiama:
- \`dist/**\`
- \`node_modules/**\`

## Veiksmas
- Padaryti X.

## Patikra
- \`pnpm build\`
- \`pnpm test\`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Y liks kitam task'ui.
`;

test("etalono failas pats grąžina tuščią Violation[] (teigiamas kontrolinis atvejis)", async () => {
  const markdown = await loadEtalonas();
  assert.deepEqual(validateTaskAgainstEtalonas(markdown, []), []);
});

test("bazinis validus task'as taip pat grąžina tuščią Violation[]", () => {
  assert.deepEqual(validateTaskAgainstEtalonas(VALID_TASK, []), []);
});

test("taisyklė 1: trūkstama privaloma sekcija blokuojama", () => {
  const withoutStop = VALID_TASK.replace(/## Stop\nCommit'ink, kai patikros žalios\.\n\n/, "");
  const violations = validateTaskAgainstEtalonas(withoutStop, []);
  assert.ok(
    violations.some((v) => v.ruleId === "mandatory-section-missing" && v.section === "## Stop"),
    "trūkstamas ## Stop turi būti pažymėtas",
  );
});

test("taisyklė 1: sekcijos ne etalono tvarka blokuojamos", () => {
  const outOfOrder = VALID_TASK.replace(
    "## Tikslas\nProblema su įrodymu.\n\n## Agentai\nreadme-guard -> coder -> tester\n\n",
    "## Agentai\nreadme-guard -> coder -> tester\n\n## Tikslas\nProblema su įrodymu.\n\n",
  );
  const violations = validateTaskAgainstEtalonas(outOfOrder, []);
  assert.ok(
    violations.some((v) => v.ruleId === "mandatory-section-order"),
    "## Tikslas po ## Agentai turi būti pažymėtas kaip tvarkos pažeidimas",
  );
});

test("taisyklė 1: visos privalomos sekcijos etalono tvarka — praeina", () => {
  const violations = validateTaskAgainstEtalonas(VALID_TASK, []);
  assert.ok(
    !violations.some((v) => v.ruleId === "mandatory-section-missing" || v.ruleId === "mandatory-section-order"),
  );
});

test("taisyklė 2: ## Failai katalogo wildcard be pagrindimo blokuojamas", () => {
  const withWildcard = VALID_TASK.replace("- `src/domain/example.ts`", "- `src/tests/**`");
  const violations = validateTaskAgainstEtalonas(withWildcard, []);
  assert.ok(
    violations.some((v) => v.ruleId === "failai-wildcard-without-justification"),
    "src/tests/** be pagrindimo turi būti pažymėtas",
  );
});

test("taisyklė 2: wildcard su pagrindimo eilute šalia — praeina", () => {
  const withJustifiedWildcard = VALID_TASK.replace(
    "- `src/domain/example.ts`",
    "- `AG/benchmark/**` (visa apimtis migracija, sąmoningas nuoseklumas)",
  );
  const violations = validateTaskAgainstEtalonas(withJustifiedWildcard, []);
  assert.ok(!violations.some((v) => v.ruleId === "failai-wildcard-without-justification"));
});

test("taisyklė 2: Draudžiama sąrašo wildcard'ai (dist/**, node_modules/**) niekada nežymimi", () => {
  const violations = validateTaskAgainstEtalonas(VALID_TASK, []);
  assert.ok(!violations.some((v) => v.ruleId === "failai-wildcard-without-justification"));
});

function withPriklausomybes(body: string): string {
  return VALID_TASK.replace("## Tikslas\n", `## Priklausomybės\n${body}\n\n## Tikslas\n`);
}

test("taisyklė 3: ## Priklausomybės placeholder blokuojamas", () => {
  const violations = validateTaskAgainstEtalonas(withPriklausomybes("- none"), []);
  assert.ok(violations.some((v) => v.ruleId === "priklausomybe-placeholder"));
});

test("taisyklė 3: ## Priklausomybės nuoroda į nežinomą id blokuojama", () => {
  const violations = validateTaskAgainstEtalonas(withPriklausomybes("- 999-nezinomas-taskas"), [
    "001-zinomas-taskas",
  ]);
  assert.ok(violations.some((v) => v.ruleId === "priklausomybe-unknown-id"));
});

test("taisyklė 3: ## Priklausomybės nuoroda į žinomą id — praeina", () => {
  const violations = validateTaskAgainstEtalonas(withPriklausomybes("- 001-zinomas-taskas"), [
    "001-zinomas-taskas",
  ]);
  assert.ok(!violations.some((v) => v.ruleId === "priklausomybe-placeholder" || v.ruleId === "priklausomybe-unknown-id"));
});

test("taisyklė 4: ## Patikra komanda ne iš leistinų formų blokuojama", () => {
  const withNpm = VALID_TASK.replace("- `pnpm test`", "- `npm test`");
  const violations = validateTaskAgainstEtalonas(withNpm, []);
  const found = violations.find((v) => v.ruleId === "patikra-unknown-command");
  assert.ok(found, "npm test turi būti pažymėtas kaip neleistina forma");
  assert.match(found?.message ?? "", /pnpm build.*pnpm test.*pnpm --dir ui-app build/);
});

test("taisyklė 4: leistinos ## Patikra formos (build, test, ui-app build) — praeina", () => {
  const withUiApp = VALID_TASK.replace(
    "- `pnpm build`\n- `pnpm test`",
    "- `pnpm build`\n- `pnpm test`\n- `pnpm --dir ui-app build`",
  );
  const violations = validateTaskAgainstEtalonas(withUiApp, []);
  assert.ok(!violations.some((v) => v.ruleId === "patikra-unknown-command"));
});
