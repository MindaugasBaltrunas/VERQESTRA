// 158-a-02: pure text-edit of `## Failai` for the accept-scope flow (rollback_failed parks
// closed without requeue). Covers: note placed above `Leidžiama:`, path appended at the end of
// the list, repeated calls are no-ops, missing `## Failai` errors, and the result still
// conforms to the etalon structure validator.
import assert from "node:assert/strict";
import test from "node:test";
import { acceptScopePaths } from "../domain/tasks/failai-scope-edit.js";
import { validateTaskAgainstEtalonas } from "../domain/tasks/etalonas-rules.js";

const TASK = `# Task

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

const NOTE = "2026-09-03: accept-scope po rollback_failed (darbas žalias)";

test("pastaba įterpiama tuoj po ## Failai antraštės, prieš Leidžiama:", () => {
  const result = acceptScopePaths(TASK, ["src/domain/example-extra.ts"], NOTE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const lines = result.value.split("\n");
  const headingIdx = lines.indexOf("## Failai");
  const allowIdx = lines.indexOf("Leidžiama:");
  assert.ok(headingIdx !== -1 && allowIdx !== -1);
  assert.equal(lines[headingIdx + 1], `> ${NOTE}`);
  assert.ok(headingIdx + 1 < allowIdx, "pastaba turi būti prieš Leidžiama:");
});

test("naujas kelias pridedamas Leidžiama: sąrašo gale, prieš Draudžiama:", () => {
  const result = acceptScopePaths(TASK, ["src/domain/example-extra.ts"], NOTE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const lines = result.value.split("\n");
  const denyIdx = lines.indexOf("Draudžiama:");
  const newPathIdx = lines.indexOf("- `src/domain/example-extra.ts`");
  const existingPathIdx = lines.indexOf("- `src/domain/example.ts`");
  assert.ok(newPathIdx !== -1 && denyIdx !== -1 && existingPathIdx !== -1);
  assert.ok(existingPathIdx < newPathIdx, "naujas kelias turi eiti po esamo");
  assert.ok(newPathIdx < denyIdx, "naujas kelias turi likti Leidžiama: bloke");
});

test("jau esantis kelias nedubliuojamas", () => {
  const result = acceptScopePaths(TASK, ["src/domain/example.ts"], NOTE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const occurrences = result.value.split("- `src/domain/example.ts`").length - 1;
  assert.equal(occurrences, 1);
});

test("pakartotinis kvietimas tais pačiais argumentais nieko nekeičia (idempotentiška)", () => {
  const first = acceptScopePaths(TASK, ["src/domain/example-extra.ts"], NOTE);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = acceptScopePaths(first.value, ["src/domain/example-extra.ts"], NOTE);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value, first.value);
});

test("trūkstama ## Failai sekcija grąžina err", () => {
  const withoutFailai = TASK.replace(
    /## Failai\nLeidžiama:\n- `src\/domain\/example\.ts`\n- `src\/tests\/example\.test\.ts`\n\nDraudžiama:\n- `dist\/\*\*`\n- `node_modules\/\*\*`\n\n/,
    "",
  );
  assert.ok(!withoutFailai.includes("## Failai"));
  const result = acceptScopePaths(withoutFailai, ["src/domain/example-extra.ts"], NOTE);
  assert.deepEqual(result, { ok: false, error: { code: "missing_failai_section", message: "task has no `## Failai` section" } });
});

test("rezultatas praeina validateTaskAgainstEtalonas", () => {
  const result = acceptScopePaths(TASK, ["src/domain/example-extra.ts"], NOTE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(validateTaskAgainstEtalonas(result.value, []), []);
});
