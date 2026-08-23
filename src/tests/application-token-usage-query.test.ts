// `GET /api/token-usage` filtrų ir puslapiavimo testai (2026-08-23 UI audito antras ratas).
//
// Iki šio modulio maršrutas buvo prijungtas prie SUVESTINĖS (`summarizeTokenUsage`), tad
// `#/analytics` lentelė gaudavo ne tuos duomenis, o visi filtrai buvo ignoruojami. Šie testai
// pin'ina abu dalykus: formą (`records` + `pagination`) ir tai, kad kiekvienas filtras realiai
// veikia.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTokenUsageQueryResponse,
  filterTokenUsageRecords,
  normalizeTokenUsageLimit,
  normalizeTokenUsageOffset,
  parseTokenUsageQueryRecords,
} from "../application/analytics/token-usage-query.js";

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

const LOG = [
  line({ ts: "2026-08-20T10:00:00.000Z", task_id: "0001", phase: "preflight", model: "haiku", input_tokens: 10 }),
  line({ ts: "2026-08-21T10:00:00.000Z", task_id: "0002", phase: "implementation", model: "sonnet", input_tokens: 20 }),
  "{ sugadinta eilutė",
  line({ ts: "2026-08-22T10:00:00.000Z", task_id: "0002", phase: "implementation", model: "haiku", input_tokens: 30 }),
  line({ phase: "be-ts", model: "haiku" }),
  line({ ts: "2026-08-23T10:00:00.000Z", task_id: "0003", phase: "diagnose", model: "opus", total_cost_usd: 0.5 }),
].join("\n");

test("parsinimas tolerantiškas, o įrašas perduodamas VISAS", () => {
  const records = parseTokenUsageQueryRecords(LOG);

  // Sugadinta eilutė kainuoja tik save; eilutė be `task_id` neturi ko rodyti, tad praleidžiama.
  assert.equal(records.length, 4);
  // `total_cost_usd` nėra siaurame learning pjūvyje, bet PRIKLAUSO kliento kontraktui — siauras
  // pjūvis jį tyliai numestų.
  assert.equal(records[3]?.["total_cost_usd"], 0.5);
});

test("filtrai: modelis, fazė ir task id", () => {
  const records = parseTokenUsageQueryRecords(LOG);

  assert.deepEqual(
    filterTokenUsageRecords(records, { model: "haiku" }).map((record) => record.task_id),
    ["0001", "0002"],
  );
  assert.deepEqual(
    filterTokenUsageRecords(records, { phase: "implementation" }).map((record) => record.model),
    ["sonnet", "haiku"],
  );
  assert.equal(filterTokenUsageRecords(records, { task_id: "0003" }).length, 1);
});

test("datos riba be laiko dalies ĮSKAITO visą dieną", () => {
  const records = parseTokenUsageQueryRecords(LOG);

  // `to=2026-08-21` be išplėtimo atmestų visus tos dienos įrašus (`"…T10:00:00Z" > "2026-08-21"`),
  // t. y. filtras tyliai prarastų paskutinę dieną.
  assert.deepEqual(
    filterTokenUsageRecords(records, { from: "2026-08-21", to: "2026-08-21" }).map((record) => record.task_id),
    ["0002"],
  );
  assert.equal(filterTokenUsageRecords(records, { from: "2026-08-22" }).length, 2);
});

test("be puslapiavimo grąžinami visi įrašai ir jokio `pagination` bloko", () => {
  const response = buildTokenUsageQueryResponse(LOG);

  assert.equal(response.records.length, 4);
  assert.equal(response.pagination, undefined);
});

test("puslapiavimas eina nuo ŽURNALO GALO: `offset: 0` yra naujausi", () => {
  const response = buildTokenUsageQueryResponse(LOG, {}, { limit: 2, offset: 0 });

  assert.deepEqual(
    response.records.map((record) => record.task_id),
    ["0002", "0003"],
  );
  assert.deepEqual(response.pagination, {
    total_records: 4,
    returned_records: 2,
    offset: 0,
    limit: 2,
    has_more: true,
  });
});

test("`has_more` yra `false`, kai už grąžintų įrašų istorijos nebėra", () => {
  const response = buildTokenUsageQueryResponse(LOG, {}, { limit: 10, offset: 0 });

  assert.equal(response.records.length, 4);
  assert.equal(response.pagination?.has_more, false);
});

test("`?limit=0` yra AIŠKUS be-ribos nurodymas, o šiukšlė krenta į numatytąją", () => {
  assert.equal(normalizeTokenUsageLimit("0"), undefined);
  assert.equal(normalizeTokenUsageLimit("25"), 25);
  assert.equal(normalizeTokenUsageLimit("labas"), 500);
  assert.equal(normalizeTokenUsageLimit(null), 500);
  // Viršutinės lubos saugo nuo vienos užklausos, atiduodančios visą žurnalą.
  assert.equal(normalizeTokenUsageLimit("999999"), 5000);
  assert.equal(normalizeTokenUsageOffset("-5"), 0);
  assert.equal(normalizeTokenUsageOffset("12"), 12);
});

test("tuščias žurnalas duoda tuščią atsakymą, o ne klaidą", () => {
  assert.deepEqual(buildTokenUsageQueryResponse(undefined).records, []);
  assert.deepEqual(buildTokenUsageQueryResponse("").records, []);
});
