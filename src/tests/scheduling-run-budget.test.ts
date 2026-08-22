// Run lygio biudžetas ready-set'ui: kada jis egzistuoja ir kada ne.
//
// `BuildReadySetInput.budget` buvo prijungtas prie hardcoded `() => undefined`, tad
// `budget-exhausted` ir `budget-insufficient` produkcijoje nebuvo pasiekiami. Prijungti nebuvo
// prie ko: visos esamos ribos yra PER-TASK, ir paėmus bet kurią iš jų vieno task'o likutis būtų
// tapęs visos eilės riba. Todėl riba yra atskira ir neprivaloma — o šie testai pin'ina abi puses:
// nedeklaravus ribos elgsena nesikeičia, deklaravus mechanizmas realiai veikia.

import assert from "node:assert/strict";
import test from "node:test";
import { RUN_BUDGET_CONFIG_KEY, readRunBudget } from "../application/scheduling/run-budget.js";

const LF = "\n";

const usage = (...billable: readonly number[]): string =>
  billable
    .map((tokens) => JSON.stringify({ task_id: "0001", input_tokens: tokens, output_tokens: 0, usage_captured: true }))
    .map((line) => `${line}${LF}`)
    .join("");

const ports = (config: string | undefined, log: string | undefined) => ({
  readBudgetConfig: () => Promise.resolve(config),
  readUsageLog: () => Promise.resolve(log),
});

test("be deklaruotos ribos biudžeto nėra — elgsena nesikeičia", async () => {
  assert.equal(await readRunBudget(ports(undefined, usage(100))), undefined, "nėra konfigo");
  assert.equal(await readRunBudget(ports("{}", usage(100))), undefined, "konfigas be rakto");
  assert.equal(await readRunBudget(ports(JSON.stringify({ [RUN_BUDGET_CONFIG_KEY]: 0 }), "")), undefined, "nulis nėra riba");

  // Sugadintas konfigas NEĮJUNGIA ribos, kurios operatorius nedeklaravo. Užrakinti visą eilę dėl
  // neperskaitomo failo reikštų sustabdyti darbą dėl dalyko, kurio niekas nepamatavo.
  assert.equal(await readRunBudget(ports("{ ne json", usage(100))), undefined);
});

test("deklaravus ribą, likutis skaičiuojamas iš run'o išlaidų", async () => {
  const config = JSON.stringify({ [RUN_BUDGET_CONFIG_KEY]: 1_000 });

  const fresh = await readRunBudget(ports(config, undefined));
  assert.deepEqual(fresh, { remaining_tokens: 1_000, exhausted: false }, "be žurnalo išleista nulis");

  // Sumuojama per VISUS įrašus, ne per vieną task'ą: klausimas yra „kiek liko eilei".
  const partial = await readRunBudget(ports(config, usage(300, 200)));
  assert.deepEqual(partial, { remaining_tokens: 500, exhausted: false });

  const spent = await readRunBudget(ports(config, usage(600, 400)));
  assert.deepEqual(spent, { remaining_tokens: 0, exhausted: true }, "tiksliai išnaudota jau yra išnaudota");

  // Perviršis nerodomas kaip neigiamas likutis: `remaining_tokens` yra kiekis, ne skola.
  const over = await readRunBudget(ports(config, usage(900, 900)));
  assert.deepEqual(over, { remaining_tokens: 0, exhausted: true });
});
