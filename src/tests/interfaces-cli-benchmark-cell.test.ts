// `ag-loop` celės grynoji dalis: scenarijaus promptas → užduotis, loop'o usage įrašai → vokas.
//
// Kontekstas, be kurio šie testai atrodo formalūs: iki 2026-08-22 `ag-loop` režimą varė vienas
// headless `claude` kvietimas, tad `attempts`, `repairs` ir `humanReviewEvents` buvo įrašytos
// konstantos (1, 0, 0). Šie skaičiai yra vienintelis dalykas, skiriantis loop'ą nuo plikos
// agento sesijos, tad jų teisingumas ir yra visas šio režimo matavimas.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  cellChangeDir,
  cellTaskPath,
  renderCellSpec,
  renderCellTask,
  summarizeCellTelemetry,
  type CellUsageRecord,
} from "../interfaces/cli/benchmark/benchmark-cell.js";

const PROMPT = "`test/i18n-missing-key.test.mjs` fails.\n\nFix the lookup so a missing key falls back.";

test("renderCellTask: promptas VERBATIM, ribos ir patikros iš scenarijaus", () => {
  const task = renderCellTask({
    prompt: PROMPT,
    allowedPaths: ["src/i18n.mjs"],
    checks: [{ command: ["node", "--test", "test/i18n-missing-key.test.mjs"] }],
    taskId: "0001-bugfix-i18n",
  });

  // BENCH-3: abu režimai gauna TĄ PATĮ promptą. Bet koks perrašymas čia reikštų, kad loop'o
  // režimas matuojamas su kita užduotimi nei solo.
  assert.ok(task.includes(PROMPT.trim()), "promptas privalo įeiti nepakeistas");
  assert.match(task, /## Failai\nLeidžiama:\n- `src\/i18n\.mjs`/);
  assert.match(task, /- `node --test test\/i18n-missing-key\.test\.mjs`/);
  assert.match(task, /Draudžiama:\n- `\.git\/\*\*`\n- `vq\/\*\*`/);
  // Agentų grandinę renka preflight — įrašyta čia, ji matuotų mūsų spėjimą, ne loop'ą.
  assert.doesNotMatch(task, /## Agentai/);
});

test("renderCellTask: scenarijus be leidžiamų kelių atmetamas, o ne paverčiamas „viskas leidžiama“", () => {
  assert.throws(
    () => renderCellTask({ prompt: PROMPT, allowedPaths: [], checks: [], taskId: "0002-x" }),
    /no allowed path/,
  );
});

test("cellTaskPath: užduotis atsiduria scenarijaus kopijos eilėje", () => {
  const target = cellTaskPath("/tmp/cell", "0003-y");
  assert.ok(target.endsWith(path.join("AG", "tasks", "queue", "0003-y.md")));
});

function record(overrides: Partial<CellUsageRecord> = {}): CellUsageRecord {
  return {
    task_id: "0001-bugfix-i18n",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1_000,
    cache_creation_input_tokens: 200,
    num_turns: 2,
    attempt: 1,
    usage_captured: true,
    ...overrides,
  };
}

test("summarizeCellTelemetry: sumuoja ciklą ir skiria bandymus nuo kvietimų", () => {
  const telemetry = summarizeCellTelemetry(
    [
      record(),
      record({ attempt: 1 }),
      record({ attempt: 2, task_phase: "repair" }),
      record({ task_id: "kitas-taskas", input_tokens: 999_999 }),
    ],
    "0001-bugfix-i18n",
  );

  assert.equal(telemetry.llmCalls, 3, "svetimo task'o įrašas neįeina");
  assert.equal(telemetry.inputTokens, 300);
  assert.equal(telemetry.outputTokens, 150);
  assert.equal(telemetry.cacheReadInputTokens, 3_000);
  assert.equal(telemetry.cacheCreationInputTokens, 600);
  assert.equal(telemetry.numTurns, 6);
  // Trys kvietimai, DU bandymai: suskaičiavus kvietimus kaip bandymus, `repairs < attempts`
  // liktų teisingas atsitiktinai.
  assert.equal(telemetry.attempts, 2);
  assert.equal(telemetry.repairs, 1, "remontas — loop'o paties liudijimas, ne mūsų išvedimas");
  assert.equal(telemetry.captured, true);
  assert.ok(telemetry.repairs < telemetry.attempts, "adapterio invariantas galioja");
});

test("summarizeCellTelemetry: nenuskaityta usage pažymima, o ne tyliai praleidžiama", () => {
  const telemetry = summarizeCellTelemetry([record(), record({ usage_captured: false })], "0001-bugfix-i18n");
  assert.equal(telemetry.captured, false, "trūkstami tokenai buvo išleisti — tylėjimas sumažintų šį režimą");
  assert.equal(telemetry.llmCalls, 2);
});

test("summarizeCellTelemetry: nė vieno įrašo — nulis kvietimų ir nulis bandymų", () => {
  const telemetry = summarizeCellTelemetry([], "0001-bugfix-i18n");
  assert.equal(telemetry.llmCalls, 0);
  assert.equal(telemetry.attempts, 0);
  assert.equal(telemetry.captured, false);
});

test("summarizeCellTelemetry: kvietimas be `attempt` vis tiek yra bandymas", () => {
  // `attempts: 0` su `llmCalls > 0` būtų prieštaravimas, kurį adapteris teisingai atmestų kaip
  // sugadintą telemetriją — o darbas juk įvyko.
  const { attempt: _omitted, ...withoutAttempt } = record();
  const telemetry = summarizeCellTelemetry([withoutAttempt], "0001-bugfix-i18n");
  assert.equal(telemetry.attempts, 1);
  assert.equal(telemetry.repairs, 0);
});

// Pirmas gyvas celės paleidimas 2026-08-22 sustojo ties preflight: „Source-code task is missing
// an active openspec/changes/<change-id>/ reference" — nulis modelio kvietimų. Tai teisinga
// loop'o elgsena (SH-2), tad celė privalo atnešti scenarijų ir kaip spec change'ą.
test("renderCellSpec: scenarijus atkeliauja kaip spec change'as, o užduotis į jį rodo", () => {
  const cell = {
    prompt: PROMPT,
    allowedPaths: ["src/i18n.mjs"],
    checks: [{ command: ["node", "--test", "test/i18n.test.mjs"] }],
    taskId: "bugfix-i18n",
  };
  const files = renderCellSpec(cell);
  const dir = cellChangeDir("bugfix-i18n");

  assert.deepEqual(
    [...files.keys()].sort(),
    [`${dir}/design.md`, `${dir}/proposal.md`, `${dir}/spec.md`, `${dir}/tasks.md`],
  );

  // Struktūra pridedama, INFORMACIJA ne: spec'e gulì tas pats promptas. Priešingu atveju loop'o
  // režimas gautų daugiau, nei gavo solo, ir BENCH-3 nustotų galioti.
  const spec = files.get(`${dir}/spec.md`) ?? "";
  assert.ok(spec.includes(PROMPT.trim()));
  assert.ok(spec.includes("## Apimtis"), "spec deklaruoja apimtį");
  assert.ok(spec.includes("- `src/i18n.mjs`"), "apimtis yra scenarijaus riba");

  // Užduotis privalo rodyti į change'ą — kitaip preflight jo neras.
  assert.ok(renderCellTask(cell).includes(`## Spec source\n${dir}/spec.md`));
});
