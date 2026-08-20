// Post-run truth join testai (VQ-305 3/3-f, task 0042). Elgesio etalonas: AG_loop
// post-run-truth-join testų branduolys: rakto specifiškumo tvarka, eilučių išmetimo
// taisyklės ir acceptance rezoliucija.

import assert from "node:assert/strict";
import { test } from "node:test";
import { joinPostRunTruth } from "../application/analytics/post-run-truth-join.js";

test("join'as renkasi specifiškiausią raktą: attempt_id > task+attempt > task", () => {
  const rows = joinPostRunTruth(
    [
      { task_id: "T-1", attempt: 2, attempt_id: "a2", raw_task_chars: 1000, worker_prompt_chars: 400 },
      { task_id: "T-2", attempt: 1, raw_task_chars: 500, worker_prompt_chars: 300 },
    ],
    [
      { task_id: "T-1", attempt: 2, attempt_id: "a2", input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30 },
      { task_id: "T-1", input_tokens: 999 },
      { task_id: "T-2", attempt: 1, input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 0 },
    ],
    [
      { task_id: "T-1", ts: "2026-08-10T10:00:00.000Z", to_state: "done" },
      { task_id: "T-2", ts: "2026-08-10T10:00:00.000Z", to_state: "human-review" },
    ],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    task_id: "T-1",
    attempt: 2,
    attempt_id: "a2",
    raw_chars: 1000,
    compiled_chars: 400,
    input_tokens: 100,
    cache_creation: 30,
    billable: 150,
    accepted: true,
  });
  assert.equal(rows[1]?.accepted, false);
  assert.equal(rows[1]?.billable, 55);
});

test("eilutė be prompt matavimo arba be usage partnerio išmetama, o be įvykių accepted=null", () => {
  const rows = joinPostRunTruth(
    [
      { task_id: "T-1", raw_task_chars: 1000, worker_prompt_chars: 400 },
      // Be worker_prompt_chars — nėra patikimo compiled matavimo.
      { task_id: "T-2", raw_task_chars: 500 },
      // Su matavimu, bet be token-usage partnerio.
      { task_id: "T-3", raw_task_chars: 700, worker_prompt_chars: 200 },
    ],
    [{ task_id: "T-1", input_tokens: 10 }],
    [],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.task_id, "T-1");
  assert.equal(rows[0]?.accepted, null);
});

test("dublikato raktas išsprendžiamas į paskutinį įrašą (last write wins), vėliausias įvykis sprendžia arm'ą", () => {
  const rows = joinPostRunTruth(
    [{ task_id: "T-1", raw_task_chars: 100, worker_prompt_chars: 50 }],
    [
      { task_id: "T-1", input_tokens: 1 },
      { task_id: "T-1", input_tokens: 2 },
    ],
    [
      { task_id: "T-1", ts: "2026-08-10T10:00:00.000Z", to_state: "human-review" },
      { task_id: "T-1", ts: "2026-08-10T11:00:00.000Z", to_state: "done" },
    ],
  );
  assert.equal(rows[0]?.input_tokens, 2);
  assert.equal(rows[0]?.accepted, true);
});
