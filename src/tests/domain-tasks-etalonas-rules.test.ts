// 071: struktūrinis etalono validatorius. Kiekvienai taisyklei po blokavimo ir po praėjimo
// atvejį, plius teigiamas kontrolinis atvejis — pats etalono failas privalo grąžinti tuščią
// Violation[] (jis pats yra visų sekcijų, įskaitant neprivalomas, kanoninis pavyzdys).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateTaskAgainstEtalonas } from "../domain/tasks/etalonas-rules.js";

const ETALONAS_PATH = path.resolve(process.cwd(), "AG", "tasks", "examples", "000-etalonas.md");
const TASKS_ROOT = path.resolve(process.cwd(), "AG", "tasks");

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
- \`src/tests/example.test.ts\`

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

test("taisyklė 5: ## Patikra be nė vienos backtick komandos blokuojama", () => {
  const withoutBackticks = VALID_TASK.replace(
    "## Patikra\n- `pnpm build`\n- `pnpm test`\n",
    "## Patikra\n- pnpm build\n- pnpm test\n",
  );
  const violations = validateTaskAgainstEtalonas(withoutBackticks, []);
  assert.ok(violations.some((v) => v.ruleId === "patikra-without-backtick-check"));
});

test("taisyklė 5: ## Patikra su backtick komandomis — praeina", () => {
  const violations = validateTaskAgainstEtalonas(VALID_TASK, []);
  assert.ok(!violations.some((v) => v.ruleId === "patikra-without-backtick-check"));
});

test("taisyklė 6: produkcinis src/** failas be testo kelio blokuojamas", () => {
  const withoutTest = VALID_TASK.replace("- `src/tests/example.test.ts`\n", "");
  const violations = validateTaskAgainstEtalonas(withoutTest, []);
  assert.ok(violations.some((v) => v.ruleId === "production-file-without-test"));
});

test("taisyklė 6: produkcinis src/** failas su testo keliu — praeina", () => {
  const violations = validateTaskAgainstEtalonas(VALID_TASK, []);
  assert.ok(!violations.some((v) => v.ruleId === "production-file-without-test"));
});

const UI_TASK_WITHOUT_COVERAGE = VALID_TASK.replace(
  "- `src/domain/example.ts`\n- `src/tests/example.test.ts`",
  "- `ui-app/src/view/components/SomePanel.tsx`\n- `src/tests/example.test.ts`",
);

test("taisyklė 7: UI komponentas be I18nContext ir dashboard CSS blokuojamas", () => {
  const violations = validateTaskAgainstEtalonas(UI_TASK_WITHOUT_COVERAGE, []);
  assert.ok(violations.some((v) => v.ruleId === "ui-file-without-i18n-context"));
  assert.ok(violations.some((v) => v.ruleId === "ui-file-without-dashboard-css"));
});

test("taisyklė 7: UI komponentas su I18nContext ir dashboard CSS — praeina", () => {
  const uiTaskWithCoverage = UI_TASK_WITHOUT_COVERAGE.replace(
    "- `ui-app/src/view/components/SomePanel.tsx`\n",
    "- `ui-app/src/view/components/SomePanel.tsx`\n" +
      "- `ui-app/src/i18n/I18nContext.tsx`\n" +
      "- `ui-app/src/view/styles/13-buttons.css`\n",
  );
  const violations = validateTaskAgainstEtalonas(uiTaskWithCoverage, []);
  assert.ok(!violations.some((v) => v.ruleId === "ui-file-without-i18n-context"));
  assert.ok(!violations.some((v) => v.ruleId === "ui-file-without-dashboard-css"));
});

// --- 157: šešios naujos deterministinės taisyklės (auditas 2026-09-03, R2–R4) ------------

test("taisyklė 8: prozinė ## Priklausomybės eilutė blokuojama (R2: LOOP STOP all-blocked)", () => {
  const prose = withPriklausomybes("- 137 pirmoji dalis: in-flight išvedimas per portą");
  const found = validateTaskAgainstEtalonas(prose, ["137-in-flight"]).find(
    (v) => v.ruleId === "priklausomybe-not-a-task-id",
  );
  assert.ok(found, "prozinė priklausomybė turi būti pažymėta");
  assert.match(found?.detail ?? "", /137 pirmoji dalis/);
});

test("taisyklė 8: etalono `<…>` šablonas ir tikras id — praeina", () => {
  const template = validateTaskAgainstEtalonas(withPriklausomybes("- <pilnas-task-id-be-md>"), []);
  assert.ok(!template.some((v) => v.ruleId === "priklausomybe-not-a-task-id"));
  const realId = validateTaskAgainstEtalonas(withPriklausomybes("- 001-zinomas-taskas"), ["001-zinomas-taskas"]);
  assert.ok(!realId.some((v) => v.ruleId === "priklausomybe-not-a-task-id"));
});

test("taisyklė 8: be knownTaskIds tikrinama tik id forma, ne rezoliucija", () => {
  const violations = validateTaskAgainstEtalonas(withPriklausomybes("- 999-nezinomas-taskas"));
  assert.ok(!violations.some((v) => v.ruleId === "priklausomybe-unknown-id"));
  assert.ok(!violations.some((v) => v.ruleId === "priklausomybe-not-a-task-id"));
});

test("taisyklė 9: `> …` anotacija tarp Leidžiama: ir Draudžiama: blokuojama (R3: 101-b-03)", () => {
  const withProse = VALID_TASK.replace(
    "Leidžiama:\n",
    "Leidžiama:\n> Pastaba: žr. `docs/audits/etalonas-tests-audit-2026-09-03.md` ir `vq/logs/orchestrator.log`.\n",
  );
  const found = validateTaskAgainstEtalonas(withProse, []).find((v) => v.ruleId === "failai-prose-inside-leidziama");
  assert.ok(found, "ne-bullet eilutė su backtick'ais turi būti pažymėta");
  assert.match(found?.message ?? "", /VIRŠ `Leidžiama:`/);
});

test("taisyklė 9: anotacija VIRŠ Leidžiama: ir tęstinė bullet'o eilutė — praeina", () => {
  const aboveMarker = VALID_TASK.replace(
    "## Failai\nLeidžiama:\n",
    "## Failai\n> Pastaba: žr. `docs/audits/etalonas-tests-audit-2026-09-03.md`.\nLeidžiama:\n",
  );
  assert.ok(!validateTaskAgainstEtalonas(aboveMarker, []).some((v) => v.ruleId === "failai-prose-inside-leidziama"));

  const folded = VALID_TASK.replace(
    "- `src/tests/example.test.ts`\n",
    "- `src/tests/example.test.ts` (numatomas naujas; jei testas gyvena\n  kitur — `src/tests/kitas.test.ts` vietoje šio)\n",
  );
  assert.ok(!validateTaskAgainstEtalonas(folded, []).some((v) => v.ruleId === "failai-prose-inside-leidziama"));
});

test("taisyklė 10: tas pats kelias Leidžiama IR Draudžiama blokuojamas", () => {
  const conflicting = VALID_TASK.replace("Draudžiama:\n", "Draudžiama:\n- `src/domain/example.ts`\n");
  const found = validateTaskAgainstEtalonas(conflicting, []).find(
    (v) => v.ruleId === "failai-path-both-allowed-and-forbidden",
  );
  assert.ok(found, "dviprasmiškas kelias turi būti pažymėtas");
  assert.equal(found?.detail, "src/domain/example.ts");
});

test("taisyklė 10: nesikertantys Leidžiama/Draudžiama sąrašai — praeina", () => {
  const violations = validateTaskAgainstEtalonas(VALID_TASK, []);
  assert.ok(!violations.some((v) => v.ruleId === "failai-path-both-allowed-and-forbidden"));
});

test("taisyklė 11: tuščias ## Neįtraukta kūnas blokuojamas", () => {
  const empty = VALID_TASK.replace("## Neįtraukta\nY liks kitam task'ui.\n", "## Neįtraukta\n");
  assert.ok(validateTaskAgainstEtalonas(empty, []).some((v) => v.ruleId === "neitraukta-empty"));
});

test("taisyklė 11: ## Neįtraukta su turiniu — praeina", () => {
  assert.ok(!validateTaskAgainstEtalonas(VALID_TASK, []).some((v) => v.ruleId === "neitraukta-empty"));
});

const CACHE_VERSION_STEP = "- Pakelti `CONTEXT_CACHE_VERSION`, nes keičiasi pack'o turinys.";

test("taisyklė 12: CONTEXT_CACHE_VERSION be abiejų pinančių testų blokuojamas (138 parkas)", () => {
  const withCacheVersion = VALID_TASK.replace("- Padaryti X.", CACHE_VERSION_STEP);
  const found = validateTaskAgainstEtalonas(withCacheVersion, []).find(
    (v) => v.ruleId === "cache-version-without-pin-tests",
  );
  assert.ok(found, "CONTEXT_CACHE_VERSION be pin'ų turi būti pažymėtas");
  assert.match(found?.detail ?? "", /context-pack-guards\.test\.ts/);
  assert.match(found?.detail ?? "", /context-pack-code-index-identity\.test\.ts/);
});

test("taisyklė 12: CONTEXT_CACHE_VERSION su abiem pinančiais testais — praeina", () => {
  const withPins = VALID_TASK.replace("- Padaryti X.", CACHE_VERSION_STEP).replace(
    "- `src/tests/example.test.ts`\n",
    "- `src/tests/example.test.ts`\n" +
      "- `src/tests/context-pack-guards.test.ts`\n" +
      "- `src/tests/context-pack-code-index-identity.test.ts`\n",
  );
  assert.ok(!validateTaskAgainstEtalonas(withPins, []).some((v) => v.ruleId === "cache-version-without-pin-tests"));
});

test("taisyklė 12: vien tik ## Failai minintis CONTEXT_CACHE_VERSION nežymimas (taisyklė tekstinė)", () => {
  const violations = validateTaskAgainstEtalonas(VALID_TASK, []);
  assert.ok(!violations.some((v) => v.ruleId === "cache-version-without-pin-tests"));
});

test("taisyklė 13: ## Agentai grandinė ne nuo readme-guard blokuojama", () => {
  const withoutGuard = VALID_TASK.replace("readme-guard -> coder -> tester", "coder -> reviewer -> tester");
  const found = validateTaskAgainstEtalonas(withoutGuard, []).find(
    (v) => v.ruleId === "agentai-readme-guard-not-first",
  );
  assert.ok(found, "grandinė be readme-guard priekyje turi būti pažymėta");
  assert.match(found?.message ?? "", /prasideda "coder"/);
});

test("taisyklė 13: label'is prieš grandinę toleruojamas — praeina", () => {
  const labelled = VALID_TASK.replace(
    "readme-guard -> coder -> tester",
    "Privaloma grandinė: readme-guard -> coder -> tester",
  );
  assert.ok(!validateTaskAgainstEtalonas(labelled, []).some((v) => v.ruleId === "agentai-readme-guard-not-first"));
});

// --- Korpusas: gyvi queue/human-review task'ai privalo praeiti visas taisykles -----------
//
// R5 radinys: domain validatoriui korpuso testo nebuvo, tad task'as, praeinantis loop'ą, bet
// krentantis hook'e (arba atvirkščiai), likdavo nematomas iki incidento. `done` NEtikrinamas
// sąmoningai — 300 istorinių task'ų rašyti iki šių taisyklių.

async function markdownStems(bucket: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(TASKS_ROOT, bucket), { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

const LIVE_BUCKETS = ["queue", "human-review"] as const;
const ALL_BUCKETS = ["queue", "active", "delegated", "done", "human-review", "error", "failed"] as const;

test("korpusas: kiekvienas AG/tasks/queue ir AG/tasks/human-review task'as grąžina tuščią Violation[]", async () => {
  const known = (await Promise.all(ALL_BUCKETS.map(markdownStems))).flat();
  const failures: string[] = [];
  for (const bucket of LIVE_BUCKETS) {
    for (const stem of await markdownStems(bucket)) {
      const file = path.join(TASKS_ROOT, bucket, `${stem}.md`);
      const violations = validateTaskAgainstEtalonas(await readFile(file, "utf8"), known);
      for (const v of violations) failures.push(`${bucket}/${stem}.md :: ${v.ruleId} :: ${v.detail ?? v.message}`);
    }
  }
  assert.deepEqual(failures, [], `gyvi task'ai pažeidžia etaloną:\n${failures.join("\n")}`);
});
