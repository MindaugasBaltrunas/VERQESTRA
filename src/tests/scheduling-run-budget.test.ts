// Run lygio biudžetas ready-set'ui: kada jis egzistuoja ir kada ne.
//
// `BuildReadySetInput.budget` buvo prijungtas prie hardcoded `() => undefined`, tad
// `budget-exhausted` ir `budget-insufficient` produkcijoje nebuvo pasiekiami. Prijungti nebuvo
// prie ko: visos esamos ribos yra PER-TASK, ir paėmus bet kurią iš jų vieno task'o likutis būtų
// tapęs visos eilės riba. Todėl riba yra atskira ir neprivaloma — o šie testai pin'ina abi puses:
// nedeklaravus ribos elgsena nesikeičia, deklaravus mechanizmas realiai veikia.
//
// Semantika yra RUN pjūvis, ne viso gyvavimo suma (task 133): žurnalo `run_id` filtruoja
// išlaidas į einamąjį run'ą, tad ankstesnio run'o įrašai naujo ribos nesenina.

import assert from "node:assert/strict";
import test from "node:test";
import { RUN_BUDGET_CONFIG_KEY, readRunBudget } from "../application/scheduling/run-budget.js";

const LF = "\n";
const RUN_A = "11111111-1111-1111-1111-111111111111";
const RUN_B = "22222222-2222-2222-2222-222222222222";

const usage = (runId: string, ...billable: readonly number[]): string =>
  billable
    .map((tokens) =>
      JSON.stringify({ task_id: "0001", run_id: runId, input_tokens: tokens, output_tokens: 0, usage_captured: true }),
    )
    .map((line) => `${line}${LF}`)
    .join("");

const ports = (config: string | undefined, log: string | undefined, runId: string = RUN_A) => ({
  readBudgetConfig: () => Promise.resolve(config),
  readUsageLog: () => Promise.resolve(log),
  runId,
});

test("be deklaruotos ribos biudžeto nėra — elgsena nesikeičia", async () => {
  assert.equal(await readRunBudget(ports(undefined, usage(RUN_A, 100))), undefined, "nėra konfigo");
  assert.equal(await readRunBudget(ports("{}", usage(RUN_A, 100))), undefined, "konfigas be rakto");
  assert.equal(await readRunBudget(ports(JSON.stringify({ [RUN_BUDGET_CONFIG_KEY]: 0 }), "")), undefined, "nulis nėra riba");

  // Sugadintas konfigas NEĮJUNGIA ribos, kurios operatorius nedeklaravo. Užrakinti visą eilę dėl
  // neperskaitomo failo reikštų sustabdyti darbą dėl dalyko, kurio niekas nepamatavo.
  assert.equal(await readRunBudget(ports("{ ne json", usage(RUN_A, 100))), undefined);
});

test("deklaravus ribą, likutis skaičiuojamas iš ŠIO run'o išlaidų", async () => {
  const config = JSON.stringify({ [RUN_BUDGET_CONFIG_KEY]: 1_000 });

  const fresh = await readRunBudget(ports(config, undefined));
  assert.deepEqual(fresh, { remaining_tokens: 1_000, exhausted: false }, "be žurnalo išleista nulis");

  const partial = await readRunBudget(ports(config, usage(RUN_A, 300, 200)));
  assert.deepEqual(partial, { remaining_tokens: 500, exhausted: false });

  const spent = await readRunBudget(ports(config, usage(RUN_A, 600, 400)));
  assert.deepEqual(spent, { remaining_tokens: 0, exhausted: true }, "tiksliai išnaudota jau yra išnaudota");

  // Perviršis nerodomas kaip neigiamas likutis: `remaining_tokens` yra kiekis, ne skola.
  const over = await readRunBudget(ports(config, usage(RUN_A, 900, 900)));
  assert.deepEqual(over, { remaining_tokens: 0, exhausted: true });
});

test("naujas run'as nepaveldi ankstesnio run'o išlaidų", async () => {
  const config = JSON.stringify({ [RUN_BUDGET_CONFIG_KEY]: 1_000 });

  // Run A išnaudojo visą ribą.
  const log = usage(RUN_A, 600, 400);
  const runAExhausted = await readRunBudget(ports(config, log, RUN_A));
  assert.deepEqual(runAExhausted, { remaining_tokens: 0, exhausted: true }, "run A pats save mato išnaudotą");

  // Tas pats žurnalas, bet KITAS run_id — riba atsistato, nes pjūvis yra run-scoped, ne
  // viso gyvavimo suma.
  const runBFresh = await readRunBudget(ports(config, log, RUN_B));
  assert.deepEqual(runBFresh, { remaining_tokens: 1_000, exhausted: false }, "run B nemato run A išlaidų");

  // Abiejų run'ų įrašai tame pačiame žurnale — kiekvienas run'as mato tik savo pjūvį.
  const mixed = `${usage(RUN_A, 900, 900)}${usage(RUN_B, 300)}`;
  const runBPartial = await readRunBudget(ports(config, mixed, RUN_B));
  assert.deepEqual(runBPartial, { remaining_tokens: 700, exhausted: false }, "run B mato tik savo 300");
});
